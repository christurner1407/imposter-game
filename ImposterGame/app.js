const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const server = http.createServer(app);

// Trust proxy (required for Cloudflare/nginx)
app.set("trust proxy", true);

// Configuration from environment variables
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(function(s) { return s.trim(); })
    .filter(Boolean);

// Add localhost defaults for development
if (ALLOWED_ORIGINS.length === 0) {
    ALLOWED_ORIGINS.push(
        "http://localhost:3000", 
        "http://127.0.0.1:3000",
        "https://impostor.bigboychris.com"
    );
}

// Resource limits from environment or defaults
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS, 10) || 100;
const MAX_PLAYERS_PER_ROOM = parseInt(process.env.MAX_PLAYERS_PER_ROOM, 10) || 20;
const ROOM_INACTIVE_TIMEOUT = (parseInt(process.env.ROOM_TIMEOUT_MINUTES, 10) || 30) * 60 * 1000;
const MIN_CUSTOM_WORDS = 5;
const MAX_WORD_LENGTH = 30;
const MIN_IMPOSTORS = 1;
const MAX_IMPOSTORS = 3;
const IMPOSTOR_GUESS_TIMEOUT = 30000; // 30 seconds

// Input validation constants
const MAX_NAME_LENGTH = 20;
const MIN_NAME_LENGTH = 1;
const NAME_PATTERN = /^[a-zA-Z0-9 _-]+$/;
const ROOM_CODE_PATTERN = /^[A-Z]{4}$/;

// Rate limiting config per event (requests per minute)
const EVENT_RATE_LIMITS = {
    createSession: { max: 5, windowMs: 60000 },
    joinSession: { max: 10, windowMs: 60000 },
    startGame: { max: 10, windowMs: 60000 },
    requestStartVoting: { max: 20, windowMs: 60000 },
    requestEndVoting: { max: 20, windowMs: 60000 },
    submitVote: { max: 30, windowMs: 60000 },
    submitWordGuess: { max: 10, windowMs: 60000 },
    requestPlayAgain: { max: 10, windowMs: 60000 },
    selectCategory: { max: 30, windowMs: 60000 },
    selectMode: { max: 30, windowMs: 60000 },
    setImpostorCount: { max: 30, windowMs: 60000 },
    submitCustomWords: { max: 20, windowMs: 60000 },
    kickPlayer: { max: 20, windowMs: 60000 },
    endRound: { max: 10, windowMs: 60000 }
};

// HTTP Security hardening
app.disable("x-powered-by");
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'", "ws:", "wss:"]
        }
    }
}));

// HTTP rate limiting
const httpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: "Too many requests, please try again later.",
    standardHeaders: true,
    legacyHeaders: false
});
app.use(httpLimiter);

// Health check endpoint for monitoring and reverse proxies
app.get("/healthz", function(req, res) {
    res.status(200).send("ok");
});

app.use(express.static("public"));

// Socket.IO with CORS restrictions (Cloudflare compatible - WebSocket only)
const io = new Server(server, {
    cors: {
        origin: function(origin, callback) {
            if (!origin) return callback(null, true);
            if (origin === "https://impostor.bigboychris.com") return callback(null, true);
            if (origin.startsWith("http://localhost")) return callback(null, true);
            console.warn("Blocked origin:", origin);
            return callback(null, false);
        },
        credentials: true
    },
    transports: ["websocket"]
});

// In-memory rooms storage
const rooms = {};

// Map playerId to their current socket and room
const playerSockets = {};

// Per-socket rate limiting state
const socketRateLimits = new Map();

// Server-side categories with word lists
const categories = {
    "Animals": [
        "Dog", "Cat", "Fish", "Bird", "Rabbit", "Horse", "Cow", "Pig", "Chicken", "Duck",
        "Frog", "Snake", "Turtle", "Bear", "Lion", "Tiger", "Elephant", "Monkey", "Zebra",
        "Giraffe", "Penguin", "Shark", "Whale", "Dolphin", "Butterfly", "Bee", "Spider",
        "Ant", "Mouse", "Hamster", "Sheep", "Goat", "Donkey", "Deer", "Fox", "Wolf",
        "Owl", "Eagle", "Parrot", "Flamingo", "Kangaroo", "Koala", "Panda", "Hippo",
        "Crocodile", "Octopus", "Crab", "Snail", "Ladybug", "Bat"
    ],
    "Foods": [
        "Pizza", "Burger", "Hot Dog", "Taco", "Sandwich", "Pasta", "Rice", "Bread",
        "Cheese", "Egg", "Bacon", "Chicken", "Fish", "Steak", "Soup", "Salad",
        "French Fries", "Popcorn", "Chips", "Cookie", "Cake", "Ice Cream", "Candy",
        "Chocolate", "Donut", "Pancake", "Waffle", "Cereal", "Toast", "Muffin",
        "Apple", "Banana", "Orange", "Grape", "Strawberry", "Watermelon", "Pineapple",
        "Carrot", "Broccoli", "Corn", "Potato", "Tomato", "Peanut Butter", "Jelly",
        "Milk", "Juice", "Soda", "Cupcake", "Pie", "Yogurt"
    ],
    "Places": [
        "School", "House", "Park", "Beach", "Pool", "Zoo", "Farm", "Hospital",
        "Store", "Mall", "Restaurant", "Library", "Museum", "Church", "Castle",
        "Forest", "Mountain", "Lake", "River", "Ocean", "Desert", "Island", "Cave",
        "Playground", "Garden", "Kitchen", "Bedroom", "Bathroom", "Garage", "Backyard",
        "Airport", "Train Station", "Bus Stop", "Gas Station", "Fire Station", "Police Station",
        "Movie Theater", "Circus", "Carnival", "Stadium", "Gym", "Hotel", "Camp",
        "Jungle", "North Pole", "Space", "Moon", "Volcano", "Waterfall", "Rainbow"
    ],
    "Things": [
        "Ball", "Book", "Phone", "Computer", "TV", "Chair", "Table", "Bed", "Door",
        "Window", "Clock", "Lamp", "Mirror", "Umbrella", "Backpack", "Hat", "Shoe",
        "Shirt", "Pants", "Glasses", "Watch", "Key", "Lock", "Bottle", "Cup", "Plate",
        "Fork", "Spoon", "Knife", "Scissors", "Pencil", "Pen", "Paper", "Box", "Bag",
        "Toy", "Doll", "Teddy Bear", "Balloon", "Kite", "Bike", "Car", "Bus", "Train",
        "Airplane", "Boat", "Rocket", "Drum", "Guitar", "Piano"
    ],
    "Actions": [
        "Running", "Walking", "Jumping", "Swimming", "Dancing", "Singing", "Sleeping",
        "Eating", "Drinking", "Reading", "Writing", "Drawing", "Painting", "Cooking",
        "Cleaning", "Washing", "Brushing Teeth", "Taking a Bath", "Getting Dressed",
        "Playing", "Laughing", "Crying", "Smiling", "Waving", "Clapping", "Hugging",
        "Kicking", "Throwing", "Catching", "Climbing", "Hiding", "Sneaking", "Flying",
        "Driving", "Riding a Bike", "Skating", "Skiing", "Fishing", "Camping", "Building",
        "Digging", "Planting", "Watering", "Feeding", "Petting", "Chasing", "Racing"
    ],
    "Movies & Shows": [
        "Frozen", "Toy Story", "Finding Nemo", "Lion King", "Shrek", "Moana",
        "Spider-Man", "Batman", "Superman", "Incredibles", "Cars", "Monsters Inc",
        "Up", "Coco", "Encanto", "Luca", "Ratatouille", "Wall-E", "Inside Out",
        "Zootopia", "Big Hero 6", "Tangled", "Aladdin", "Little Mermaid", "Cinderella",
        "Beauty and the Beast", "Snow White", "Pinocchio", "Dumbo", "Bambi",
        "Peter Pan", "Jungle Book", "Tarzan", "Mulan", "Pocahontas", "Hercules",
        "Minions", "Despicable Me", "Kung Fu Panda", "How to Train Your Dragon",
        "Trolls", "Paw Patrol", "Peppa Pig", "SpongeBob", "Mickey Mouse",
        "Dora", "Blues Clues", "Sesame Street", "Barbie", "Pokemon"
    ],
    "Jobs": [
        "Doctor", "Nurse", "Teacher", "Firefighter", "Police Officer", "Chef", "Baker",
        "Farmer", "Pilot", "Astronaut", "Scientist", "Artist", "Singer", "Dancer",
        "Actor", "Clown", "Magician", "Vet", "Zookeeper", "Lifeguard", "Coach",
        "Driver", "Builder", "Plumber", "Electrician", "Mechanic", "Dentist",
        "Mailman", "Waiter", "Cashier", "Librarian", "Principal", "Janitor",
        "Photographer", "Reporter", "Weatherman", "Judge", "Lawyer", "Mayor",
        "King", "Queen", "Princess", "Prince", "Knight", "Pirate", "Superhero",
        "Ninja", "Cowboy", "Explorer", "Soldier"
    ],
    "Sports & Games": [
        "Soccer", "Basketball", "Baseball", "Football", "Tennis", "Golf", "Swimming",
        "Running", "Jumping", "Gymnastics", "Dancing", "Skating", "Skiing", "Surfing",
        "Biking", "Bowling", "Fishing", "Camping", "Hiking", "Tag", "Hide and Seek",
        "Jump Rope", "Hopscotch", "Freeze Tag", "Duck Duck Goose", "Red Light Green Light",
        "Simon Says", "Musical Chairs", "Hot Potato", "Dodgeball", "Kickball",
        "Catch", "Frisbee", "Hula Hoop", "Yo-Yo", "Video Games", "Board Games",
        "Card Games", "Puzzles", "Legos", "Play-Doh", "Coloring", "Dress Up",
        "Tea Party", "Fort Building", "Treasure Hunt", "Racing", "Wrestling"
    ]
};

// ============ UTILITY FUNCTIONS ============

// Check socket event rate limit
function checkRateLimit(socket, eventName) {
    const limit = EVENT_RATE_LIMITS[eventName];
    if (!limit) return true; // No limit defined
    
    const socketId = socket.id;
    if (!socketRateLimits.has(socketId)) {
        socketRateLimits.set(socketId, {});
    }
    
    const socketLimits = socketRateLimits.get(socketId);
    const now = Date.now();
    
    if (!socketLimits[eventName]) {
        socketLimits[eventName] = { count: 0, windowStart: now };
    }
    
    const eventLimit = socketLimits[eventName];
    
    // Reset window if expired
    if (now - eventLimit.windowStart > limit.windowMs) {
        eventLimit.count = 0;
        eventLimit.windowStart = now;
    }
    
    eventLimit.count++;
    
    if (eventLimit.count > limit.max) {
        console.log("Rate limit exceeded for", eventName, "from socket", socketId);
        socket.emit("gameError", "Too many requests. Please slow down.");
        return false;
    }
    
    return true;
}

// Validate player name
function isValidName(name) {
    if (!name || typeof name !== "string") return false;
    const trimmed = name.trim();
    if (trimmed.length < MIN_NAME_LENGTH || trimmed.length > MAX_NAME_LENGTH) return false;
    return NAME_PATTERN.test(trimmed);
}

// Validate room code
function isValidRoomCode(code) {
    if (!code || typeof code !== "string") return false;
    return ROOM_CODE_PATTERN.test(code.toUpperCase());
}

// Validate custom word
function isValidWord(word) {
    if (!word || typeof word !== "string") return false;
    const trimmed = word.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_WORD_LENGTH) return false;
    return /^[a-zA-Z0-9 ]+$/.test(trimmed);
}

// Generate unique 4-character uppercase code
function generateCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let code;
    let attempts = 0;
    do {
        code = "";
        for (let i = 0; i = 4; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        attempts++;
        if (attempts > 1000) {
            console.log("Warning: Too many attempts to generate room code");
            return null;
        }
    } while (rooms[code]);
    return code;
}

// Shuffle array (Fisher-Yates)
function shuffleArray(array) {
    const arr = array.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Get room count
function getRoomCount() {
    return Object.keys(rooms).length;
}

// Update room activity timestamp
function touchRoom(code) {
    if (rooms[code]) {
        rooms[code].lastActivity = Date.now();
    }
}

// Clean up inactive rooms
function cleanupInactiveRooms() {
    const now = Date.now();
    let cleaned = 0;
    
    Object.keys(rooms).forEach(function(code) {
        const room = rooms[code];
        if (now - room.lastActivity > ROOM_INACTIVE_TIMEOUT) {
            // Clear any pending timeouts
            if (room.guessTimeout) {
                clearTimeout(room.guessTimeout);
            }
            
            // Remove player socket mappings
            room.players.forEach(function(player) {
                delete playerSockets[player.id];
            });
            
            delete rooms[code];
            cleaned++;
            console.log("Cleaned up inactive room:", code);
        }
    });
    
    if (cleaned > 0) {
        console.log("Cleaned up", cleaned, "inactive rooms. Active rooms:", getRoomCount());
    }
}

// Run cleanup every 5 minutes
setInterval(cleanupInactiveRooms, 5 * 60 * 1000);

// Transition room to a new phase
function setPhase(code, newPhase) {
    const room = rooms[code];
    if (!room) return;
    room.phase = newPhase;
    touchRoom(code);
    io.to(code).emit("phaseChanged", { phase: newPhase });
    console.log("Session " + code + " phase changed to: " + newPhase);
}

// Update turn order by removing eliminated players
function updateTurnOrder(code) {
    const room = rooms[code];
    if (!room || !room.turnOrder) return;
    
    // Filter out eliminated players from turn order
    room.turnOrder = room.turnOrder.filter(function(player) {
        const roomPlayer = room.players.find(function(p) { return p.id === player.id; });
        return roomPlayer && !roomPlayer.eliminated;
    });
    
    // Emit updated turn order to all players
    io.to(code).emit("turnOrder", room.turnOrder);
}

// End game with impostor guess result
function endGameAfterGuess(code, guessCorrect) {
    const room = rooms[code];
    if (!room) return;
    
    if (room.guessTimeout) {
        clearTimeout(room.guessTimeout);
        room.guessTimeout = null;
    }
    
    room.pendingImpostorGuess = false;
    room.eliminatedImpostorId = null;
    
    if (guessCorrect) {
        setPhase(code, "ended");
        io.to(code).emit("gameEnded", { 
            winner: "impostor", 
            reason: "The impostor guessed the secret word!" 
        });
    } else {
        setPhase(code, "ended");
        const reason = room.impostorCount === 1 ? "The impostor was eliminated and failed to guess the word!" : "All impostors were eliminated!";
        io.to(code).emit("gameEnded", { 
            winner: "crew", 
            reason: reason 
        });
    }
}

// Tally votes and determine elimination
function tallyVotes(code) {
    const room = rooms[code];
    if (!room) return;

    const voteCounts = {};
    const alivePlayers = room.players.filter(function(p) { return !p.eliminated; });
    
    alivePlayers.forEach(function(p) {
        voteCounts[p.id] = 0;
    });

    Object.values(room.votes).forEach(function(votedId) {
        if (voteCounts[votedId] !== undefined) {
            voteCounts[votedId]++;
        }
    });

    let maxVotes = 0;
    let eliminated = [];

    Object.entries(voteCounts).forEach(function(entry) {
        const playerId = entry[0];
        const count = entry[1];
        if (count > maxVotes) {
            maxVotes = count;
            eliminated = [playerId];
        } else if (count === maxVotes && count > 0) {
            eliminated.push(playerId);
        }
    });

    let eliminatedPlayer = null;
    if (eliminated.length === 1 && maxVotes > 0) {
        const playerId = eliminated[0];
        const player = room.players.find(function(p) { return p.id === playerId; });
        if (player) {
            player.eliminated = true;
            eliminatedPlayer = {
                id: player.id,
                name: player.name,
                role: room.roles[player.id]
            };
        }
    }

    const voteResults = {
        votes: voteCounts,
        eliminated: eliminatedPlayer,
        tie: eliminated.length > 1,
        noVotes: maxVotes === 0
    };
    io.to(code).emit("voteResults", voteResults);
    io.to(code).emit("playerList", room.players);

    setPhase(code, "results");
    console.log("Vote results in " + code + ":", voteResults);

    if (eliminatedPlayer && eliminatedPlayer.role === "impostor") {
        const aliveImpostors = room.players.filter(function(p) { 
            return !p.eliminated && room.roles[p.id] === "impostor"; 
        });
        
        if (aliveImpostors.length === 0) {
            room.pendingImpostorGuess = true;
            room.eliminatedImpostorId = eliminatedPlayer.id;
            
            const impostorSocketId = playerSockets[eliminatedPlayer.id];
            if (impostorSocketId) {
                const impostorSocket = io.sockets.sockets.get(impostorSocketId);
                if (impostorSocket) {
                    impostorSocket.emit("impostorGuessPrompt", { 
                        timeLimit: IMPOSTOR_GUESS_TIMEOUT / 1000 
                    });
                }
            }
            
            room.players.forEach(function(player) {
                if (player.id !== eliminatedPlayer.id) {
                    const playerSocketId = playerSockets[player.id];
                    if (playerSocketId) {
                        const playerSocket = io.sockets.sockets.get(playerSocketId);
                        if (playerSocket) {
                            playerSocket.emit("impostorGuessing", { 
                                impostorName: eliminatedPlayer.name,
                                timeLimit: IMPOSTOR_GUESS_TIMEOUT / 1000
                            });
                        }
                    }
                }
            });
            
            room.guessTimeout = setTimeout(function() {
                if (room.pendingImpostorGuess) {
                    console.log("Impostor guess timed out in session " + code);
                    endGameAfterGuess(code, false);
                }
            }, IMPOSTOR_GUESS_TIMEOUT);
            
            return;
        }
    }

    checkWinConditions(code);
}

// Check win conditions
function checkWinConditions(code) {
    const room = rooms[code];
    if (!room) return;
    
    if (room.pendingImpostorGuess) return;

    const alivePlayers = room.players.filter(function(p) { return !p.eliminated; });
    const aliveImpostors = alivePlayers.filter(function(p) { return room.roles[p.id] === "impostor"; });
    const aliveCrew = alivePlayers.filter(function(p) { return room.roles[p.id] === "crew"; });

    if (aliveImpostors.length === 0) {
        setPhase(code, "ended");
        const reason = room.impostorCount === 1 ? "The impostor was eliminated!" : "All impostors were eliminated!";
        io.to(code).emit("gameEnded", { winner: "crew", reason: reason });
    } else if (aliveImpostors.length >= aliveCrew.length) {
        // Impostors win when they equal or outnumber crew members
        setPhase(code, "ended");
        if (aliveImpostors.length === 1) {
            io.to(code).emit("gameEnded", { winner: "impostor", reason: "The impostor has taken over!" });
        } else {
            io.to(code).emit("gameEnded", { winner: "impostor", reason: "The impostors have taken over!" });
        }
    }
}

// Reset room for play again
function resetRoomForPlayAgain(code) {
    const room = rooms[code];
    if (!room) {
        console.log("resetRoomForPlayAgain: room not found");
        return;
    }
    
    console.log("resetRoomForPlayAgain: starting reset for", code);
    
    if (room.guessTimeout) {
        clearTimeout(room.guessTimeout);
        room.guessTimeout = null;
    }
    
    room.started = false;
    room.phase = "lobby";
    room.roles = {};
    room.secretWord = null;
    room.votes = {};
    room.pendingImpostorGuess = false;
    room.eliminatedImpostorId = null;
    touchRoom(code);
    
    room.players.forEach(function(player) {
        player.eliminated = false;
    });
    
    console.log("resetRoomForPlayAgain: emitting gameReset to room", code);
    
    io.to(code).emit("gameReset");
    io.to(code).emit("playerList", room.players);
    io.to(code).emit("phaseChanged", { phase: "lobby" });
    io.to(code).emit("modeChanged", { mode: room.mode });
    io.to(code).emit("impostorCountChanged", { count: room.impostorCount || 1 });
    
    if (room.mode === "preset" && room.selectedCategory) {
        io.to(code).emit("categorySelected", room.selectedCategory);
    }
    if (room.mode === "custom" && room.customWords.length > 0) {
        io.to(code).emit("customWordsUpdated", {
            words: room.customWords,
            valid: room.customWords.length >= MIN_CUSTOM_WORDS,
            count: room.customWords.length,
            minRequired: MIN_CUSTOM_WORDS
        });
    }
    
    console.log("resetRoomForPlayAgain: complete for", code);
}

// Find player in room by playerId
function findPlayerInRoom(room, playerId) {
    return room.players.find(function(p) { return p.id === playerId; });
}

// Validate vote target
function isValidVoteTarget(room, voterId, targetId) {
    if (!room || !voterId || !targetId) return false;
    
    const voter = room.players.find(function(p) { return p.id === voterId; });
    const target = room.players.find(function(p) { return p.id === targetId; });
    
    if (!voter || !target) return false;
    if (voter.eliminated) return false;
    if (target.eliminated) return false;
    
    return true;
}

// ============ SOCKET.IO HANDLERS ============

io.on("connection", function(socket) {
    console.log("Socket connected:", socket.id);
    
    // Initialize rate limit state for this socket
    socketRateLimits.set(socket.id, {});

    socket.on("getCategories", function() {
        socket.emit("categoriesList", Object.keys(categories));
    });

    socket.on("reconnect", function(data) {
        if (!data || !data.playerId || !data.roomCode) {
            socket.emit("reconnectFailed");
            return;
        }
        
        const playerId = data.playerId;
        const roomCode = data.roomCode.toUpperCase();
        const playerName = data.playerName;
        
        if (!isValidRoomCode(roomCode)) {
            socket.emit("reconnectFailed");
            return;
        }
        
        const room = rooms[roomCode];
        if (!room) {
            socket.emit("reconnectFailed");
            return;
        }

        const player = findPlayerInRoom(room, playerId);
        if (!player) {
            socket.emit("reconnectFailed");
            return;
        }

        if (playerSockets[playerId] && playerSockets[playerId] !== socket.id) {
            const oldSocket = io.sockets.sockets.get(playerSockets[playerId]);
            if (oldSocket) {
                oldSocket.disconnect(true);
            }
        }

        playerSockets[playerId] = socket.id;
        socket.playerId = playerId;
        socket.roomCode = roomCode;
        socket.playerName = playerName;
        socket.join(roomCode);
        touchRoom(roomCode);

        const isHost = room.hostId === playerId;
        const role = room.roles[playerId] || null;
        const category = room.mode === "preset" ? room.selectedCategory : "Custom";
        const word = role === "crew" ? room.secretWord : null;

        socket.emit("reconnectSuccess", {
            roomCode: roomCode,
            isHost: isHost,
            phase: room.phase,
            role: role,
            category: category,
            word: word,
            eliminated: player.eliminated,
            pendingGuess: room.pendingImpostorGuess && room.eliminatedImpostorId === playerId,
            turnOrder: room.turnOrder || null
        });

        socket.emit("playerList", room.players);
        socket.emit("modeChanged", { mode: room.mode });
        socket.emit("impostorCountChanged", { count: room.impostorCount || 1 });
        if (room.mode === "preset" && room.selectedCategory) {
            socket.emit("categorySelected", room.selectedCategory);
        }

        console.log("Player " + playerName + " (" + playerId + ") reconnected to session " + roomCode);
    });

    socket.on("createSession", function(data) {
        if (!checkRateLimit(socket, "createSession")) return;
        
        if (!data || !data.playerName || !data.playerId) {
            socket.emit("joinError", "Invalid request");
            return;
        }
        
        const playerName = data.playerName.trim();
        const playerId = data.playerId;
        
        if (!isValidName(playerName)) {
            socket.emit("joinError", "Invalid name. Use 1-20 alphanumeric characters.");
            return;
        }
        
        // Check room limit
        if (getRoomCount() >= MAX_ROOMS) {
            socket.emit("joinError", "Server is full. Please try again later.");
            return;
        }
        
        const code = generateCode();
        if (!code) {
            socket.emit("joinError", "Could not create room. Please try again.");
            return;
        }
        
        if (playerSockets[playerId]) {
            const oldSocket = io.sockets.sockets.get(playerSockets[playerId]);
            if (oldSocket) {
                oldSocket.disconnect(true);
            }
        }

        rooms[code] = {
            hostId: playerId,
            started: false,
            phase: "lobby",
            mode: "preset",
            impostorCount: 1,
            players: [{ id: playerId, name: playerName, isHost: true, eliminated: false }],
            roles: {},
            selectedCategory: null,
            customWords: [],
            secretWord: null,
            votes: {},
            pendingImpostorGuess: false,
            eliminatedImpostorId: null,
            guessTimeout: null,
            lastActivity: Date.now()
        };

        playerSockets[playerId] = socket.id;
        socket.playerId = playerId;
        socket.join(code);
        socket.roomCode = code;
        socket.playerName = playerName;

        socket.emit("sessionCreated", { code: code, playerName: playerName });
        io.to(code).emit("playerList", rooms[code].players);
        io.to(code).emit("phaseChanged", { phase: "lobby" });
        io.to(code).emit("modeChanged", { mode: "preset" });
        io.to(code).emit("impostorCountChanged", { count: 1 });
        console.log("Session " + code + " created by " + playerName + " (" + playerId + "). Total rooms: " + getRoomCount());
    });

    socket.on("setImpostorCount", function(count) {
        if (!checkRateLimit(socket, "setImpostorCount")) return;
        
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        if (room.hostId !== socket.playerId) return;
        if (room.phase !== "lobby") return;
        
        const numCount = parseInt(count, 10);
        if (isNaN(numCount) || numCount < MIN_IMPOSTORS || numCount > MAX_IMPOSTORS) {
            socket.emit("gameError", "Invalid impostor count");
            return;
        }
        
        room.impostorCount = numCount;
        touchRoom(code);
        io.to(code).emit("impostorCountChanged", { count: numCount });
        console.log("Impostor count set to " + numCount + " in session " + code);
    });

    socket.on("selectMode", function(mode) {
        if (!checkRateLimit(socket, "selectMode")) return;
        
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        if (room.hostId !== socket.playerId) return;
        if (room.phase !== "lobby") return;
        if (mode !== "preset" && mode !== "custom") return;

        room.mode = mode;
        room.selectedCategory = null;
        room.customWords = [];
        touchRoom(code);
        io.to(code).emit("modeChanged", { mode: mode });
        io.to(code).emit("categorySelected", null);
        io.to(code).emit("customWordsUpdated", { words: [], valid: false });
        console.log("Mode " + mode + " selected in session " + code);
    });

    socket.on("selectCategory", function(categoryName) {
        if (!checkRateLimit(socket, "selectCategory")) return;
        
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        if (room.hostId !== socket.playerId) return;
        if (room.phase !== "lobby") return;
        if (room.mode !== "preset") return;
        if (!categories[categoryName]) {
            socket.emit("gameError", "Invalid category");
            return;
        }
        room.selectedCategory = categoryName;
        touchRoom(code);
        io.to(code).emit("categorySelected", categoryName);
        console.log("Category " + categoryName + " selected in session " + code);
    });

    socket.on("submitCustomWords", function(wordsInput) {
        if (!checkRateLimit(socket, "submitCustomWords")) return;
        
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        if (room.hostId !== socket.playerId) return;
        if (room.phase !== "lobby") return;
        if (room.mode !== "custom") return;

        if (typeof wordsInput !== "string") {
            socket.emit("gameError", "Invalid word list format");
            return;
        }

        const words = wordsInput
            .split("\n")
            .map(function(w) { return w.trim(); })
            .filter(function(w) { return w.length > 0; });

        const validWords = words.filter(isValidWord);
        const isValid = validWords.length >= MIN_CUSTOM_WORDS;

        if (isValid) {
            room.customWords = validWords;
        } else {
            room.customWords = [];
        }

        touchRoom(code);
        io.to(code).emit("customWordsUpdated", {
            words: validWords,
            valid: isValid,
            count: validWords.length,
            minRequired: MIN_CUSTOM_WORDS
        });

        if (!isValid && words.length > 0) {
            socket.emit("gameError", "Need at least " + MIN_CUSTOM_WORDS + " valid words. Words must be alphanumeric (max " + MAX_WORD_LENGTH + " chars).");
        }

        console.log("Custom words submitted in session " + code + ": " + validWords.length + " valid words");
    });

    socket.on("joinSession", function(data) {
        if (!checkRateLimit(socket, "joinSession")) return;
        
        if (!data || !data.code || !data.playerName || !data.playerId) {
            socket.emit("joinError", "Invalid request");
            return;
        }
        
        const code = data.code.toUpperCase();
        const playerName = data.playerName.trim();
        const playerId = data.playerId;
        
        if (!isValidRoomCode(code)) {
            socket.emit("joinError", "Invalid session code format");
            return;
        }
        
        if (!isValidName(playerName)) {
            socket.emit("joinError", "Invalid name. Use 1-20 alphanumeric characters.");
            return;
        }
        
        const room = rooms[code];
        if (!room) {
            socket.emit("joinError", "Invalid session code");
            return;
        }
        if (room.phase !== "lobby") {
            socket.emit("joinError", "Game already started");
            return;
        }
        
        // Check player limit
        if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
            socket.emit("joinError", "Room is full");
            return;
        }

        const existingPlayer = findPlayerInRoom(room, playerId);
        if (existingPlayer) {
            socket.emit("joinError", "Already in this session");
            return;
        }

        if (playerSockets[playerId]) {
            const oldSocket = io.sockets.sockets.get(playerSockets[playerId]);
            if (oldSocket) {
                oldSocket.disconnect(true);
            }
        }

        room.players.push({ id: playerId, name: playerName, isHost: false, eliminated: false });
        playerSockets[playerId] = socket.id;
        socket.playerId = playerId;
        socket.join(code);
        socket.roomCode = code;
        socket.playerName = playerName;
        touchRoom(code);

        socket.emit("sessionJoined", { code: code, playerName: playerName });
        io.to(code).emit("playerList", room.players);
        io.to(code).emit("phaseChanged", { phase: room.phase });
        socket.emit("modeChanged", { mode: room.mode });
        socket.emit("impostorCountChanged", { count: room.impostorCount || 1 });
        if (room.mode === "preset" && room.selectedCategory) {
            socket.emit("categorySelected", room.selectedCategory);
        }
        if (room.mode === "custom" && room.customWords.length > 0) {
            socket.emit("customWordsUpdated", {
                words: room.customWords,
                valid: room.customWords.length >= MIN_CUSTOM_WORDS,
                count: room.customWords.length,
                minRequired: MIN_CUSTOM_WORDS
            });
        }
        console.log(playerName + " (" + playerId + ") joined session " + code);
    });

    socket.on("startGame", function() {
        if (!checkRateLimit(socket, "startGame")) return;
        
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        if (room.hostId !== socket.playerId) {
            socket.emit("gameError", "Only the host can start the game");
            return;
        }
        if (room.phase !== "lobby") {
            socket.emit("gameError", "Game already started");
            return;
        }
        if (room.players.length < 2) {
            socket.emit("gameError", "Need at least 2 players");
            return;
        }

        const impostorCount = room.impostorCount || 1;
        const playerCount = room.players.length;
        
        if (impostorCount < MIN_IMPOSTORS) {
            socket.emit("gameError", "Need at least 1 impostor");
            return;
        }
        
        if (impostorCount >= playerCount) {
            socket.emit("gameError", "Need at least 1 crew member");
            return;
        }

        let wordList;
        let categoryName;

        if (room.mode === "preset") {
            if (!room.selectedCategory) {
                socket.emit("gameError", "Please select a category first");
                return;
            }
            wordList = categories[room.selectedCategory];
            categoryName = room.selectedCategory;
        } else {
            if (room.customWords.length < MIN_CUSTOM_WORDS) {
                socket.emit("gameError", "Please submit at least " + MIN_CUSTOM_WORDS + " valid custom words");
                return;
            }
            wordList = room.customWords;
            categoryName = "Custom";
        }

        room.started = true;
        room.secretWord = wordList[Math.floor(Math.random() * wordList.length)];
        room.pendingImpostorGuess = false;
        room.eliminatedImpostorId = null;
        touchRoom(code);

        // Shuffle players for role assignment
        const shuffledForRoles = shuffleArray(room.players);
        
        room.players.forEach(function(player) {
            player.eliminated = false;
        });

        shuffledForRoles.forEach(function(player, index) {
            if (index < impostorCount) {
                room.roles[player.id] = "impostor";
            } else {
                room.roles[player.id] = "crew";
            }
        });

        // Create randomized turn order (separate from role assignment)
        const turnOrder = shuffleArray(room.players).map(function(player) {
            return { id: player.id, name: player.name };
        });
        room.turnOrder = turnOrder;

        room.players.forEach(function(player) {
            const role = room.roles[player.id];
            const playerSocketId = playerSockets[player.id];
            if (playerSocketId) {
                const playerSocket = io.sockets.sockets.get(playerSocketId);
                if (playerSocket) {
                    playerSocket.emit("roleAssigned", {
                        role: role,
                        category: categoryName,
                        word: role === "impostor" ? null : room.secretWord
                    });
                }
            }
        });

        io.to(code).emit("gameStarted");
        io.to(code).emit("turnOrder", turnOrder);
        setPhase(code, "discussion");
        
        console.log("Game started in session " + code + " - Category: " + categoryName + ", Word: " + room.secretWord + ", Impostors: " + impostorCount);
    });

    socket.on("submitWordGuess", function(guess) {
        if (!checkRateLimit(socket, "submitWordGuess")) return;
        
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        if (!room.pendingImpostorGuess) return;
        if (room.eliminatedImpostorId !== socket.playerId) return;
        
        if (typeof guess !== "string" || guess.length > MAX_WORD_LENGTH) {
            socket.emit("gameError", "Invalid guess");
            return;
        }
        
        const normalizedGuess = guess.trim().toLowerCase();
        const normalizedWord = (room.secretWord || "").trim().toLowerCase();
        
        const isCorrect = normalizedGuess === normalizedWord;
        
        console.log("Impostor guess in session " + code + ": '" + guess + "' (correct: " + isCorrect + ")");
        
        io.to(code).emit("impostorGuessResult", { 
            correct: isCorrect,
            guessedWord: guess
        });
        
        endGameAfterGuess(code, isCorrect);
    });

    socket.on("endRound", function() {
        if (!checkRateLimit(socket, "endRound")) return;
        
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        
        // Only host can end round
        if (room.hostId !== socket.playerId) {
            socket.emit("gameError", "Only the host can end the round");
            return;
        }
        
        // Can only end during active game phases (not lobby or already ended)
        if (room.phase === "lobby" || room.phase === "ended") {
            socket.emit("gameError", "No active round to end");
            return;
        }
        
        console.log("Host ended round early in session " + code);
        
        // Reset the room back to lobby
        resetRoomForPlayAgain(code);
    });

    socket.on("requestStartVoting", function() {
        if (!checkRateLimit(socket, "requestStartVoting")) return;
        
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        if (room.hostId !== socket.playerId) {
            socket.emit("gameError", "Only the host can start voting");
            return;
        }
        if (room.phase !== "discussion") {
            socket.emit("gameError", "Can only start voting during discussion phase");
            return;
        }

        room.votes = {};
        touchRoom(code);
        setPhase(code, "voting");
        console.log("Host started voting in session " + code);
    });

    socket.on("requestNextRound", function() {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        if (room.hostId !== socket.playerId) {
            socket.emit("gameError", "Only the host can start the next round");
            return;
        }
        if (room.phase !== "results") {
            socket.emit("gameError", "Can only start next round after results");
            return;
        }

        const alivePlayers = room.players.filter(function(p) { return !p.eliminated; });
        const aliveImpostors = alivePlayers.filter(function(p) { return room.roles[p.id] === "impostor"; });
        const aliveCrew = alivePlayers.filter(function(p) { return room.roles[p.id] === "crew"; });

        if (aliveImpostors.length === 0 || aliveImpostors.length >= aliveCrew.length) {
            socket.emit("gameError", "Game has already ended");
            return;
        }

        room.votes = {};
        touchRoom(code);
        
        // Update turn order to remove eliminated players
        updateTurnOrder(code);
        
        setPhase(code, "discussion");
        console.log("Host started next round in session " + code);
    });

    socket.on("requestEndVoting", function() {
        if (!checkRateLimit(socket, "requestEndVoting")) return;
        
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        if (room.hostId !== socket.playerId) {
            socket.emit("gameError", "Only the host can end voting");
            return;
        }
        if (room.phase !== "voting") {
            socket.emit("gameError", "Can only end voting during voting phase");
            return;
        }

        tallyVotes(code);
        console.log("Host ended voting in session " + code);
    });

    socket.on("requestPlayAgain", function(data) {
        if (!checkRateLimit(socket, "requestPlayAgain")) return;
        
        console.log("requestPlayAgain received:", data);
        
        const code = (data && data.roomCode) || socket.roomCode;
        const playerId = (data && data.playerId) || socket.playerId;
        
        if (!code || !isValidRoomCode(code)) {
            socket.emit("gameError", "Session expired. Please refresh.");
            socket.emit("playAgainFailed");
            return;
        }
        
        const room = rooms[code];
        if (!room) {
            socket.emit("gameError", "Room not found. Please refresh.");
            socket.emit("playAgainFailed");
            return;
        }
        
        if (!playerId) {
            socket.emit("gameError", "Session expired. Please refresh.");
            socket.emit("playAgainFailed");
            return;
        }
        
        socket.roomCode = code;
        socket.playerId = playerId;
        if (!socket.rooms.has(code)) {
            socket.join(code);
        }
        
        if (room.hostId !== playerId) {
            socket.emit("gameError", "Only the host can restart the game");
            socket.emit("playAgainFailed");
            return;
        }
        
        if (room.phase !== "ended") {
            socket.emit("gameError", "Can only restart after game ends");
            socket.emit("playAgainFailed");
            return;
        }

        console.log("requestPlayAgain: resetting room", code);
        resetRoomForPlayAgain(code);
    });

    socket.on("kickPlayer", function(targetPlayerId) {
        if (!checkRateLimit(socket, "kickPlayer")) return;
        
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        
        // Only host can kick
        if (room.hostId !== socket.playerId) {
            socket.emit("gameError", "Only the host can kick players");
            return;
        }
        
        // Can't kick yourself
        if (targetPlayerId === socket.playerId) {
            socket.emit("gameError", "You cannot kick yourself");
            return;
        }
        
        // Find the target player
        const targetPlayer = room.players.find(function(p) { return p.id === targetPlayerId; });
        if (!targetPlayer) {
            socket.emit("gameError", "Player not found");
            return;
        }
        
        // Remove player from room
        room.players = room.players.filter(function(p) { return p.id !== targetPlayerId; });
        delete room.roles[targetPlayerId];
        delete room.votes[targetPlayerId];
        
        // Remove from turn order if it exists
        if (room.turnOrder) {
            room.turnOrder = room.turnOrder.filter(function(p) { return p.id !== targetPlayerId; });
        }
        
        touchRoom(code);
        
        // Notify the kicked player
        const targetSocketId = playerSockets[targetPlayerId];
        if (targetSocketId) {
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) {
                targetSocket.emit("kicked", { reason: "You were removed from the session by the host." });
                targetSocket.leave(code);
            }
            delete playerSockets[targetPlayerId];
        }
        
        // Update all remaining players
        io.to(code).emit("playerList", room.players);
        if (room.turnOrder) {
            io.to(code).emit("turnOrder", room.turnOrder);
        }
        
        console.log("Host kicked " + targetPlayer.name + " (" + targetPlayerId + ") from session " + code);
        
        // Check if this affects the game
        if (room.phase !== "lobby" && room.phase !== "ended") {
            // Check win conditions after kick
            checkWinConditions(code);
        }
    });

    socket.on("submitVote", function(votedPlayerId) {
        if (!checkRateLimit(socket, "submitVote")) return;
        
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        if (room.phase !== "voting") return;

        const voterId = socket.playerId;
        
        if (!isValidVoteTarget(room, voterId, votedPlayerId)) {
            socket.emit("gameError", "Invalid vote target");
            return;
        }

        room.votes[voterId] = votedPlayerId;
        touchRoom(code);
        
        const alivePlayers = room.players.filter(function(p) { return !p.eliminated; });
        const voteCount = Object.keys(room.votes).length;
        const aliveCount = alivePlayers.length;
        io.to(code).emit("voteUpdate", { votesSubmitted: voteCount, totalVoters: aliveCount });

        console.log(socket.playerName + " voted in session " + code);

        if (voteCount >= aliveCount) {
            console.log("All players voted in session " + code + ", auto-ending voting");
            tallyVotes(code);
        }
    });

    socket.on("disconnect", function() {
        const playerId = socket.playerId;
        const code = socket.roomCode;

        // Clean up rate limit state
        socketRateLimits.delete(socket.id);

        if (playerId && playerSockets[playerId] === socket.id) {
            delete playerSockets[playerId];
        }

        if (code && rooms[code] && rooms[code].pendingImpostorGuess && rooms[code].eliminatedImpostorId === playerId) {
            console.log("Impostor disconnected during guess phase in session " + code);
            endGameAfterGuess(code, false);
        }

        if (code && rooms[code] && rooms[code].phase === "lobby") {
            rooms[code].players = rooms[code].players.filter(function(p) { return p.id !== playerId; });
            delete rooms[code].roles[playerId];
            delete rooms[code].votes[playerId];
            
            if (rooms[code].players.length === 0) {
                delete rooms[code];
                console.log("Session " + code + " deleted (empty). Total rooms: " + getRoomCount());
            } else {
                io.to(code).emit("playerList", rooms[code].players);
            }
        }

        console.log("Socket disconnected:", socket.id);
    });
});

// Bind to all interfaces (0.0.0.0) for production
server.listen(PORT, "0.0.0.0", function() {
    console.log("Server running on port " + PORT);
    console.log("Environment: " + (process.env.NODE_ENV || "development"));
    console.log("Trust proxy: enabled");
    console.log("Allowed origins: " + JSON.stringify(ALLOWED_ORIGINS));
    console.log("Max rooms: " + MAX_ROOMS);
    console.log("Max players per room: " + MAX_PLAYERS_PER_ROOM);
    console.log("Room timeout: " + (ROOM_INACTIVE_TIMEOUT / 1000 / 60) + " minutes");
});
