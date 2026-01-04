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
    kickPlayer: { max: 20, windowMs: 60000 }
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
        "Dog", "Cat", "Elephant", "Giraffe", "Penguin", "Tiger", "Dolphin", "Eagle",
        "Lion", "Bear", "Wolf", "Fox", "Rabbit", "Deer", "Horse", "Cow", "Pig", "Sheep",
        "Goat", "Chicken", "Duck", "Turkey", "Owl", "Hawk", "Parrot", "Flamingo",
        "Peacock", "Swan", "Pelican", "Seagull", "Crow", "Sparrow", "Robin", "Cardinal",
        "Whale", "Shark", "Octopus", "Jellyfish", "Starfish", "Crab", "Lobster", "Shrimp",
        "Turtle", "Crocodile", "Alligator", "Snake", "Lizard", "Frog", "Toad", "Salamander",
        "Butterfly", "Bee", "Ant", "Spider", "Scorpion", "Beetle", "Dragonfly", "Grasshopper",
        "Monkey", "Gorilla", "Chimpanzee", "Orangutan", "Koala", "Kangaroo", "Platypus",
        "Panda", "Polar Bear", "Grizzly Bear", "Moose", "Elk", "Bison", "Buffalo",
        "Zebra", "Hippopotamus", "Rhinoceros", "Camel", "Llama", "Alpaca", "Sloth",
        "Armadillo", "Porcupine", "Hedgehog", "Raccoon", "Skunk", "Badger", "Otter",
        "Beaver", "Squirrel", "Chipmunk", "Hamster", "Guinea Pig", "Ferret", "Mole"
    ],
    "Foods": [
        "Pizza", "Sushi", "Burger", "Taco", "Pasta", "Ice Cream", "Steak", "Salad",
        "Sandwich", "Hotdog", "Burrito", "Nachos", "Quesadilla", "Enchilada", "Fajita",
        "Ramen", "Pho", "Curry", "Fried Rice", "Noodles", "Dumplings", "Spring Roll",
        "Pancakes", "Waffles", "French Toast", "Omelette", "Bacon", "Sausage", "Cereal",
        "Soup", "Chili", "Stew", "Lasagna", "Ravioli", "Gnocchi", "Risotto", "Paella",
        "Fish and Chips", "Lobster Roll", "Crab Cakes", "Shrimp Scampi", "Calamari",
        "Fried Chicken", "Roast Chicken", "Turkey", "Ribs", "Brisket", "Pulled Pork",
        "Meatloaf", "Meatballs", "Gyro", "Kebab", "Shawarma", "Falafel", "Hummus",
        "Guacamole", "Salsa", "Chips", "Popcorn", "Pretzel", "Crackers", "Cheese",
        "Bread", "Bagel", "Croissant", "Muffin", "Donut", "Cookie", "Brownie", "Cake",
        "Pie", "Cheesecake", "Pudding", "Jello", "Yogurt", "Smoothie", "Milkshake",
        "Apple", "Banana", "Orange", "Grape", "Strawberry", "Blueberry", "Watermelon",
        "Pineapple", "Mango", "Peach", "Pear", "Cherry", "Lemon", "Lime", "Coconut"
    ],
    "Countries": [
        "France", "Japan", "Brazil", "Australia", "Canada", "Egypt", "Germany", "Mexico",
        "Italy", "Spain", "Portugal", "Greece", "Turkey", "Russia", "China", "India",
        "Thailand", "Vietnam", "Indonesia", "Philippines", "South Korea", "Singapore",
        "United Kingdom", "Ireland", "Scotland", "Netherlands", "Belgium", "Switzerland",
        "Austria", "Poland", "Sweden", "Norway", "Denmark", "Finland", "Iceland",
        "Argentina", "Chile", "Peru", "Colombia", "Venezuela", "Ecuador", "Bolivia",
        "South Africa", "Kenya", "Nigeria", "Morocco", "Tanzania", "Ethiopia", "Ghana",
        "New Zealand", "Fiji", "Hawaii", "Jamaica", "Cuba", "Dominican Republic",
        "Saudi Arabia", "Israel", "Jordan", "Lebanon", "Iran", "Iraq", "Pakistan",
        "Bangladesh", "Nepal", "Sri Lanka", "Malaysia", "Myanmar", "Cambodia", "Laos",
        "Mongolia", "Kazakhstan", "Uzbekistan", "Ukraine", "Czech Republic", "Hungary",
        "Romania", "Bulgaria", "Croatia", "Serbia", "Slovenia", "Slovakia", "Lithuania"
    ],
    "Sports": [
        "Soccer", "Basketball", "Tennis", "Swimming", "Golf", "Hockey", "Baseball", "Boxing",
        "Football", "Rugby", "Cricket", "Volleyball", "Badminton", "Table Tennis", "Squash",
        "Wrestling", "Judo", "Karate", "Taekwondo", "Fencing", "Archery", "Shooting",
        "Gymnastics", "Diving", "Surfing", "Skateboarding", "Snowboarding", "Skiing",
        "Ice Skating", "Figure Skating", "Bobsled", "Curling", "Luge", "Biathlon",
        "Track and Field", "Marathon", "Sprinting", "Long Jump", "High Jump", "Pole Vault",
        "Discus", "Javelin", "Shot Put", "Hammer Throw", "Decathlon", "Triathlon",
        "Cycling", "Mountain Biking", "BMX", "Motocross", "NASCAR", "Formula One",
        "Horse Racing", "Polo", "Rodeo", "Bull Riding", "Fishing", "Hunting",
        "Rock Climbing", "Bouldering", "Hiking", "Kayaking", "Canoeing", "Rowing",
        "Water Polo", "Synchronized Swimming", "Sailing", "Windsurfing", "Kiteboarding",
        "Lacrosse", "Field Hockey", "Handball", "Racquetball", "Pickleball", "Darts",
        "Bowling", "Billiards", "Snooker", "Chess", "Poker", "Esports", "Paintball"
    ],
    "Movies": [
        "Titanic", "Avatar", "Inception", "Frozen", "Jaws", "Rocky", "Gladiator", "Shrek",
        "Star Wars", "Harry Potter", "Lord of the Rings", "The Matrix", "Jurassic Park",
        "The Godfather", "Pulp Fiction", "Forrest Gump", "The Shawshank Redemption",
        "Fight Club", "The Dark Knight", "Interstellar", "The Prestige", "Memento",
        "Toy Story", "Finding Nemo", "The Lion King", "Aladdin", "Beauty and the Beast",
        "Mulan", "Moana", "Coco", "Up", "Wall-E", "Ratatouille", "The Incredibles",
        "Spider-Man", "Iron Man", "Captain America", "Thor", "Black Panther", "Avengers",
        "Guardians of the Galaxy", "Deadpool", "X-Men", "Wolverine", "Hulk", "Ant-Man",
        "Batman", "Superman", "Wonder Woman", "Aquaman", "Flash", "Justice League",
        "James Bond", "Mission Impossible", "Fast and Furious", "John Wick", "Die Hard",
        "Terminator", "Alien", "Predator", "Robocop", "Total Recall", "Blade Runner",
        "Back to the Future", "E.T.", "Close Encounters", "Indiana Jones", "Ghostbusters",
        "Grease", "Dirty Dancing", "Footloose", "Top Gun", "Ferris Bueller", "Breakfast Club",
        "Home Alone", "Mrs Doubtfire", "Ace Ventura", "The Mask", "Dumb and Dumber",
        "Scary Movie", "Scream", "Halloween", "Friday the 13th", "Nightmare on Elm Street"
    ],
    "Objects": [
        "Chair", "Table", "Lamp", "Sofa", "Bed", "Desk", "Bookshelf", "Mirror",
        "Clock", "Watch", "Phone", "Laptop", "Keyboard", "Mouse", "Monitor", "Television",
        "Remote Control", "Camera", "Headphones", "Speaker", "Microphone", "Radio",
        "Refrigerator", "Microwave", "Oven", "Toaster", "Blender", "Coffee Maker",
        "Dishwasher", "Washing Machine", "Dryer", "Vacuum Cleaner", "Iron", "Fan",
        "Air Conditioner", "Heater", "Thermostat", "Smoke Detector", "Fire Extinguisher",
        "Umbrella", "Backpack", "Suitcase", "Wallet", "Purse", "Briefcase", "Luggage",
        "Glasses", "Sunglasses", "Contact Lens", "Binoculars", "Telescope", "Microscope",
        "Hammer", "Screwdriver", "Wrench", "Pliers", "Drill", "Saw", "Tape Measure",
        "Flashlight", "Battery", "Extension Cord", "Light Bulb", "Candle", "Lighter",
        "Key", "Lock", "Doorbell", "Doorknob", "Window", "Curtain", "Blinds",
        "Pillow", "Blanket", "Mattress", "Sheet", "Towel", "Rug", "Carpet",
        "Vase", "Plant Pot", "Picture Frame", "Painting", "Sculpture", "Trophy",
        "Pen", "Pencil", "Marker", "Eraser", "Ruler", "Scissors", "Stapler",
        "Envelope", "Stamp", "Calculator", "Calendar", "Notebook", "Folder", "Binder",
        "Toothbrush", "Toothpaste", "Soap", "Shampoo", "Razor", "Comb", "Hairbrush",
        "Bottle", "Cup", "Mug", "Glass", "Plate", "Bowl", "Fork", "Knife", "Spoon"
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
        for (let i = 0; i < 4; i++) {
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
        setPhase(code, "ended");
        io.to(code).emit("gameEnded", { winner: "impostor", reason: "Impostors have taken over!" });
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
