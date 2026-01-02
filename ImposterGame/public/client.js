// Generate or retrieve persistent player ID
function getPlayerId() {
    let playerId = localStorage.getItem("imposterPlayerId");
    if (!playerId) {
        playerId = "player_" + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
        localStorage.setItem("imposterPlayerId", playerId);
    }
    return playerId;
}

// Get stored session info for reconnect
function getStoredSession() {
    const data = localStorage.getItem("imposterSession");
    if (data) {
        try {
            return JSON.parse(data);
        } catch (e) {
            return null;
        }
    }
    return null;
}

// Store session info for reconnect
function storeSession(roomCode, playerName) {
    localStorage.setItem("imposterSession", JSON.stringify({ roomCode: roomCode, playerName: playerName }));
}

// Clear stored session
function clearSession() {
    localStorage.removeItem("imposterSession");
}

const persistentPlayerId = getPlayerId();

// Socket.IO connection - WebSocket only (Cloudflare compatible)
const socket = io({
    transports: ["websocket"],
    upgrade: false,
    secure: true
});

const lobbyDiv = document.getElementById("lobby");
const roomDiv = document.getElementById("room");
const gameDiv = document.getElementById("game");
const playerNameInput = document.getElementById("playerName");
const sessionCodeInput = document.getElementById("sessionCode");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const startBtn = document.getElementById("startBtn");
const roomCodeSpan = document.getElementById("roomCode");
const playerList = document.getElementById("playerList");
const gamePlayerList = document.getElementById("gamePlayerList");
const errorP = document.getElementById("error");
const gameErrorP = document.getElementById("gameError");
const roleDisplay = document.getElementById("roleDisplay");
const roleCard = document.getElementById("roleCard");
const roleHint = document.getElementById("roleHint");
const categoryDropdown = document.getElementById("categoryDropdown");
const selectedCategoryDisplay = document.getElementById("selectedCategoryDisplay");
const categoryInfo = document.getElementById("categoryInfo");
const wordDisplay = document.getElementById("wordDisplay");
const phaseDisplay = document.getElementById("phaseDisplay");
const phaseHeader = document.getElementById("phaseHeader");
const discussionSection = document.getElementById("discussionSection");
const votingSection = document.getElementById("votingSection");
const votePlayerList = document.getElementById("votePlayerList");
const voteStatus = document.getElementById("voteStatus");
const resultsSection = document.getElementById("resultsSection");
const resultsText = document.getElementById("resultsText");
const endedSection = document.getElementById("endedSection");
const endedCard = document.getElementById("endedCard");
const winnerText = document.getElementById("winnerText");
const winReason = document.getElementById("winReason");

// Mode elements
const modeSection = document.getElementById("modeSection");
const presetModeBtn = document.getElementById("presetModeBtn");
const customModeBtn = document.getElementById("customModeBtn");
const presetSection = document.getElementById("presetSection");
const customSection = document.getElementById("customSection");
const customHostSection = document.getElementById("customHostSection");
const customGuestSection = document.getElementById("customGuestSection");
const customWordsInput = document.getElementById("customWordsInput");
const submitWordsBtn = document.getElementById("submitWordsBtn");
const customWordsStatus = document.getElementById("customWordsStatus");
const customWordsPreview = document.getElementById("customWordsPreview");

// Impostor count elements
const impostorCountSection = document.getElementById("impostorCountSection");
const impostorCountHost = document.getElementById("impostorCountHost");
const impostorCountGuest = document.getElementById("impostorCountGuest");
const impostorCountDropdown = document.getElementById("impostorCountDropdown");
const impostorCountDisplay = document.getElementById("impostorCountDisplay");

// Host control elements
const startVotingBtn = document.getElementById("startVotingBtn");
const endVotingBtn = document.getElementById("endVotingBtn");
const nextRoundBtn = document.getElementById("nextRoundBtn");
const discussionWaiting = document.getElementById("discussionWaiting");
const votingWaiting = document.getElementById("votingWaiting");
const resultsWaiting = document.getElementById("resultsWaiting");

// Impostor guess elements
const impostorGuessSection = document.getElementById("impostorGuessSection");
const guessPromptText = document.getElementById("guessPromptText");
const guessTimerText = document.getElementById("guessTimerText");
const guessInputSection = document.getElementById("guessInputSection");
const guessWaitingSection = document.getElementById("guessWaitingSection");
const wordGuessInput = document.getElementById("wordGuessInput");
const submitGuessBtn = document.getElementById("submitGuessBtn");

// Play again elements
const playAgainBtn = document.getElementById("playAgainBtn");
const playAgainWaiting = document.getElementById("playAgainWaiting");

let isHost = false;
let currentPlayers = [];
let selectedVote = null;
let myPlayerId = persistentPlayerId;
let currentRoomCode = null;
let isEliminated = false;
let currentMode = "preset";
let gameEnded = false;
let guessTimerInterval = null;

// Try to reconnect on page load
socket.on("connect", function() {
    const storedSession = getStoredSession();
    if (storedSession) {
        socket.emit("reconnect", {
            playerId: persistentPlayerId,
            roomCode: storedSession.roomCode,
            playerName: storedSession.playerName
        });
    } else {
        lobbyDiv.classList.remove("hidden");
    }
});

createBtn.addEventListener("click", function() {
    const name = playerNameInput.value.trim();
    if (!name) {
        errorP.textContent = "Please enter your name";
        return;
    }
    errorP.textContent = "";
    socket.emit("createSession", { playerName: name, playerId: persistentPlayerId });
});

joinBtn.addEventListener("click", function() {
    const name = playerNameInput.value.trim();
    const code = sessionCodeInput.value.trim().toUpperCase();
    if (!name) {
        errorP.textContent = "Please enter your name";
        return;
    }
    if (!code) {
        errorP.textContent = "Please enter a session code";
        return;
    }
    errorP.textContent = "";
    socket.emit("joinSession", { code: code, playerName: name, playerId: persistentPlayerId });
});

startBtn.addEventListener("click", function() {
    gameErrorP.textContent = "";
    socket.emit("startGame");
});

categoryDropdown.addEventListener("change", function() {
    const category = categoryDropdown.value;
    if (category) {
        socket.emit("selectCategory", category);
    }
});

// Impostor count change handler
impostorCountDropdown.addEventListener("change", function() {
    const count = parseInt(impostorCountDropdown.value, 10);
    socket.emit("setImpostorCount", count);
});

// Mode toggle handlers
presetModeBtn.addEventListener("click", function() {
    if (isHost) {
        socket.emit("selectMode", "preset");
    }
});

customModeBtn.addEventListener("click", function() {
    if (isHost) {
        socket.emit("selectMode", "custom");
    }
});

// Submit custom words
submitWordsBtn.addEventListener("click", function() {
    const words = customWordsInput.value;
    socket.emit("submitCustomWords", words);
});

// Host control handlers
startVotingBtn.addEventListener("click", function() {
    socket.emit("requestStartVoting");
});

endVotingBtn.addEventListener("click", function() {
    socket.emit("requestEndVoting");
});

nextRoundBtn.addEventListener("click", function() {
    socket.emit("requestNextRound");
});

// Submit word guess
submitGuessBtn.addEventListener("click", function() {
    const guess = wordGuessInput.value.trim();
    if (guess) {
        submitGuessBtn.disabled = true;
        submitGuessBtn.textContent = "Submitting...";
        socket.emit("submitWordGuess", guess);
    }
});

// Play again handler
playAgainBtn.addEventListener("click", function() {
    console.log("Play Again clicked");
    console.log("  isHost:", isHost);
    console.log("  currentRoomCode:", currentRoomCode);
    console.log("  myPlayerId:", myPlayerId);
    console.log("  socket.connected:", socket.connected);
    
    if (!socket.connected) {
        console.log("Socket not connected, cannot play again");
        gameErrorP.textContent = "Connection lost. Please refresh.";
        return;
    }
    
    if (!currentRoomCode) {
        console.log("No room code, cannot play again");
        gameErrorP.textContent = "Session expired. Please refresh.";
        return;
    }
    
    playAgainBtn.disabled = true;
    playAgainBtn.textContent = "Restarting...";
    
    // Send room code and player ID with the request
    socket.emit("requestPlayAgain", { 
        roomCode: currentRoomCode, 
        playerId: myPlayerId 
    });
});

// Handle play again failure
socket.on("playAgainFailed", function() {
    console.log("playAgainFailed received");
    playAgainBtn.disabled = false;
    playAgainBtn.textContent = "Play Again";
});

// Update impostor count UI
function updateImpostorCountUI(count) {
    const text = count === 1 ? "1 Impostor" : count + " Impostors";
    impostorCountDisplay.textContent = text;
    impostorCountDropdown.value = count.toString();
    
    if (isHost) {
        impostorCountHost.classList.remove("hidden");
        impostorCountGuest.classList.add("hidden");
    } else {
        impostorCountHost.classList.add("hidden");
        impostorCountGuest.classList.remove("hidden");
    }
}

// Update mode UI
function updateModeUI(mode) {
    currentMode = mode;
    
    if (mode === "preset") {
        presetModeBtn.className = "flex-1 py-3 bg-purple-600 text-white font-medium transition-colors touch-target";
        customModeBtn.className = "flex-1 py-3 bg-gray-700 text-gray-300 font-medium transition-colors touch-target";
        presetSection.classList.remove("hidden");
        customSection.classList.add("hidden");
    } else {
        presetModeBtn.className = "flex-1 py-3 bg-gray-700 text-gray-300 font-medium transition-colors touch-target";
        customModeBtn.className = "flex-1 py-3 bg-purple-600 text-white font-medium transition-colors touch-target";
        presetSection.classList.add("hidden");
        customSection.classList.remove("hidden");
        
        if (isHost) {
            customHostSection.classList.remove("hidden");
            customGuestSection.classList.add("hidden");
        } else {
            customHostSection.classList.add("hidden");
            customGuestSection.classList.remove("hidden");
        }
    }
    
    presetModeBtn.disabled = !isHost;
    customModeBtn.disabled = !isHost;
    if (!isHost) {
        presetModeBtn.classList.add("cursor-not-allowed", "opacity-70");
        customModeBtn.classList.add("cursor-not-allowed", "opacity-70");
    }
}

// Render vote buttons
function renderVoteButtons() {
    votePlayerList.innerHTML = "";
    selectedVote = null;
    
    currentPlayers.forEach(function(player) {
        if (player.eliminated) return;
        
        const btn = document.createElement("button");
        btn.className = "w-full py-4 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-white font-medium rounded-xl transition-colors text-left px-4 flex items-center justify-between touch-target";
        btn.innerHTML = '<span>' + player.name + (player.isHost ? ' <span class="text-purple-400 text-sm">(Host)</span>' : '') + '</span><span class="vote-check hidden text-green-400 text-sm font-bold">VOTED</span>';
        btn.dataset.playerId = player.id;
        
        if (isEliminated) {
            btn.disabled = true;
            btn.classList.add("opacity-50", "cursor-not-allowed");
        } else {
            btn.addEventListener("click", function() {
                document.querySelectorAll("#votePlayerList button").forEach(function(b) {
                    b.classList.remove("bg-blue-600", "hover:bg-blue-700");
                    b.classList.add("bg-gray-700", "hover:bg-gray-600");
                    b.querySelector(".vote-check").classList.add("hidden");
                });
                btn.classList.remove("bg-gray-700", "hover:bg-gray-600");
                btn.classList.add("bg-blue-600", "hover:bg-blue-700");
                btn.querySelector(".vote-check").classList.remove("hidden");
                selectedVote = player.id;
                socket.emit("submitVote", player.id);
            });
        }
        
        votePlayerList.appendChild(btn);
    });
    
    voteStatus.textContent = isEliminated ? "You have been eliminated and cannot vote." : "Tap a player to vote";
}

// Update phase header color
function updatePhaseHeader(phase) {
    phaseHeader.className = "p-3 sm:p-4 text-center";
    switch (phase) {
        case "lobby":
            phaseHeader.classList.add("phase-lobby");
            break;
        case "discussion":
            phaseHeader.classList.add("phase-discussion");
            break;
        case "voting":
            phaseHeader.classList.add("phase-voting");
            break;
        case "results":
            phaseHeader.classList.add("phase-results");
            break;
        case "ended":
            phaseHeader.classList.add("phase-ended");
            break;
    }
}

// Hide impostor guess section
function hideImpostorGuessSection() {
    impostorGuessSection.classList.add("hidden");
    guessInputSection.classList.add("hidden");
    guessWaitingSection.classList.add("hidden");
    if (guessTimerInterval) {
        clearInterval(guessTimerInterval);
        guessTimerInterval = null;
    }
}

// Update UI based on phase
function updatePhaseUI(phase) {
    phaseDisplay.textContent = phase.toUpperCase() + " PHASE";
    updatePhaseHeader(phase);
    
    discussionSection.classList.add("hidden");
    votingSection.classList.add("hidden");
    resultsSection.classList.add("hidden");
    endedSection.classList.add("hidden");
    hideImpostorGuessSection();
    
    startVotingBtn.classList.add("hidden");
    endVotingBtn.classList.add("hidden");
    nextRoundBtn.classList.add("hidden");
    discussionWaiting.classList.add("hidden");
    votingWaiting.classList.add("hidden");
    resultsWaiting.classList.add("hidden");
    playAgainBtn.classList.add("hidden");
    playAgainWaiting.classList.add("hidden");
    
    switch (phase) {
        case "discussion":
            discussionSection.classList.remove("hidden");
            if (isHost) {
                startVotingBtn.classList.remove("hidden");
            } else {
                discussionWaiting.classList.remove("hidden");
            }
            break;
        case "voting":
            votingSection.classList.remove("hidden");
            renderVoteButtons();
            if (isHost) {
                endVotingBtn.classList.remove("hidden");
            } else {
                votingWaiting.classList.remove("hidden");
            }
            break;
        case "results":
            resultsSection.classList.remove("hidden");
            if (isHost && !gameEnded) {
                nextRoundBtn.classList.remove("hidden");
            } else if (!gameEnded) {
                resultsWaiting.classList.remove("hidden");
            }
            break;
        case "ended":
            endedSection.classList.remove("hidden");
            gameEnded = true;
            // Don't clear session here - we need it for play again
            if (isHost) {
                playAgainBtn.classList.remove("hidden");
            } else {
                playAgainWaiting.classList.remove("hidden");
            }
            break;
    }
}

// Update game player list with elimination status
function updateGamePlayerList() {
    gamePlayerList.innerHTML = "";
    currentPlayers.forEach(function(player) {
        const li = document.createElement("li");
        li.className = "flex items-center justify-between bg-gray-700 rounded-xl px-4 py-3";
        
        if (player.eliminated) {
            li.classList.add("opacity-50");
            li.innerHTML = '<span class="text-gray-400 line-through">' + player.name + (player.isHost ? ' <span class="text-purple-400 text-sm">(Host)</span>' : '') + '</span><span class="text-red-400 text-xs font-bold uppercase">Out</span>';
        } else {
            li.innerHTML = '<span class="text-white">' + player.name + (player.isHost ? ' <span class="text-purple-400 text-sm">(Host)</span>' : '') + '</span><span class="w-2 h-2 bg-green-400 rounded-full"></span>';
        }
        
        gamePlayerList.appendChild(li);
    });
    
    const me = currentPlayers.find(function(p) { return p.id === myPlayerId; });
    if (me) {
        isEliminated = me.eliminated;
    }
}

// Update lobby player list
function updatePlayerList() {
    playerList.innerHTML = "";
    currentPlayers.forEach(function(player) {
        const li = document.createElement("li");
        li.className = "flex items-center justify-between bg-gray-700 rounded-xl px-4 py-3";
        li.innerHTML = '<span class="text-white">' + player.name + '</span>' + (player.isHost ? '<span class="bg-purple-600 text-white text-xs px-2 py-1 rounded-full uppercase">Host</span>' : '<span class="w-2 h-2 bg-green-400 rounded-full"></span>');
        playerList.appendChild(li);
    });
}

// Show game screen
function showGameScreen(roomCode) {
    currentRoomCode = roomCode;
    lobbyDiv.classList.add("hidden");
    roomDiv.classList.add("hidden");
    gameDiv.classList.remove("hidden");
}

// Show room screen
function showRoomScreen(roomCode) {
    currentRoomCode = roomCode;
    lobbyDiv.classList.add("hidden");
    roomDiv.classList.remove("hidden");
    gameDiv.classList.add("hidden");
    roomCodeSpan.textContent = roomCode;
}

socket.on("sessionCreated", function(data) {
    isHost = true;
    showRoomScreen(data.code);
    storeSession(data.code, data.playerName);
    startBtn.classList.remove("hidden");
    modeSection.classList.remove("hidden");
    updateImpostorCountUI(1);
    socket.emit("getCategories");
});

socket.on("sessionJoined", function(data) {
    isHost = false;
    showRoomScreen(data.code);
    storeSession(data.code, data.playerName);
    modeSection.classList.remove("hidden");
    updateImpostorCountUI(1);
    socket.emit("getCategories");
});

socket.on("impostorCountChanged", function(data) {
    updateImpostorCountUI(data.count);
});

socket.on("reconnectSuccess", function(data) {
    isHost = data.isHost;
    currentRoomCode = data.roomCode;
    isEliminated = data.eliminated;
    gameEnded = data.phase === "ended";
    
    // Re-store session for future reconnects
    const storedSession = getStoredSession();
    if (storedSession) {
        storeSession(data.roomCode, storedSession.playerName);
    }
    
    if (data.phase === "lobby") {
        showRoomScreen(data.roomCode);
        if (isHost) {
            startBtn.classList.remove("hidden");
        }
        modeSection.classList.remove("hidden");
        updateImpostorCountUI(1);
        socket.emit("getCategories");
    } else {
        showGameScreen(data.roomCode);
        
        categoryInfo.textContent = "Category: " + data.category;
        if (data.role === "impostor") {
            roleCard.className = "rounded-xl p-4 sm:p-6 text-center bg-red-600";
            roleDisplay.textContent = "You are the IMPOSTOR";
            wordDisplay.textContent = "";
            roleHint.textContent = "You do not receive the secret word. Blend in!";
            roleHint.classList.remove("hidden");
        } else {
            roleCard.className = "rounded-xl p-4 sm:p-6 text-center bg-green-600";
            roleDisplay.textContent = "You are CREW";
            wordDisplay.textContent = data.word || "";
            roleHint.classList.add("hidden");
        }
        
        updatePhaseUI(data.phase);
        
        // Check if we need to show guess prompt
        if (data.pendingGuess) {
            showImpostorGuessInput(30);
        }
    }
});

socket.on("reconnectFailed", function() {
    clearSession();
    lobbyDiv.classList.remove("hidden");
});

socket.on("modeChanged", function(data) {
    updateModeUI(data.mode);
    selectedCategoryDisplay.textContent = "";
    customWordsStatus.textContent = "";
    customWordsPreview.textContent = "";
});

socket.on("categoriesList", function(categories) {
    categoryDropdown.innerHTML = '<option value="">-- Select Category --</option>';
    categories.forEach(function(cat) {
        const option = document.createElement("option");
        option.value = cat;
        option.textContent = cat;
        categoryDropdown.appendChild(option);
    });
    categoryDropdown.disabled = !isHost;
    if (!isHost) {
        categoryDropdown.classList.add("cursor-not-allowed", "opacity-70");
    }
});

socket.on("categorySelected", function(categoryName) {
    if (categoryName) {
        selectedCategoryDisplay.textContent = "Selected: " + categoryName;
        selectedCategoryDisplay.className = "text-green-400 text-sm min-h-[20px]";
        if (isHost) {
            categoryDropdown.value = categoryName;
        }
    } else {
        selectedCategoryDisplay.textContent = "";
        categoryDropdown.value = "";
    }
});

socket.on("customWordsUpdated", function(data) {
    if (data.valid) {
        customWordsStatus.textContent = data.count + " words ready";
        customWordsStatus.className = "text-sm mt-2 text-green-400 min-h-[20px]";
    } else if (data.count > 0) {
        customWordsStatus.textContent = data.count + "/" + data.minRequired + " words needed";
        customWordsStatus.className = "text-sm mt-2 text-red-400 min-h-[20px]";
    } else {
        customWordsStatus.textContent = "";
        customWordsStatus.className = "text-sm mt-2 min-h-[20px]";
    }
    
    if (!isHost && data.words.length > 0) {
        customWordsPreview.textContent = data.words.length + " words ready";
        customWordsPreview.className = "bg-gray-700 rounded-xl p-4 text-green-400 text-sm";
    } else if (!isHost) {
        customWordsPreview.textContent = "Waiting for host...";
        customWordsPreview.className = "bg-gray-700 rounded-xl p-4 text-gray-400 text-sm";
    }
});

socket.on("joinError", function(message) {
    errorP.textContent = message;
});

socket.on("gameError", function(message) {
    gameErrorP.textContent = message;
});

socket.on("playerList", function(players) {
    currentPlayers = players;
    updatePlayerList();
    
    if (!gameDiv.classList.contains("hidden")) {
        updateGamePlayerList();
    }
});

socket.on("gameStarted", function() {
    showGameScreen(currentRoomCode);
    isEliminated = false;
    gameEnded = false;
    updateGamePlayerList();
});

socket.on("phaseChanged", function(data) {
    updatePhaseUI(data.phase);
});

socket.on("voteUpdate", function(data) {
    if (!isEliminated) {
        voteStatus.textContent = "Votes: " + data.votesSubmitted + " of " + data.totalVoters;
    }
});

socket.on("voteResults", function(data) {
    resultsSection.classList.remove("hidden");
    votingSection.classList.add("hidden");
    
    if (data.noVotes) {
        resultsText.textContent = "No votes cast. No one eliminated.";
    } else if (data.tie) {
        resultsText.textContent = "Tie vote! No one eliminated.";
    } else if (data.eliminated) {
        const roleText = data.eliminated.role === "impostor" ? "an IMPOSTOR" : "a crew member";
        resultsText.innerHTML = '<span class="text-xl sm:text-2xl font-bold block mb-2">' + data.eliminated.name + '</span>was eliminated!<br><span class="text-base sm:text-lg mt-2 block">They were ' + roleText + '.</span>';
    } else {
        resultsText.textContent = "No one eliminated.";
    }
});

// Show impostor guess input
function showImpostorGuessInput(timeLimit) {
    resultsSection.classList.add("hidden");
    impostorGuessSection.classList.remove("hidden");
    guessInputSection.classList.remove("hidden");
    guessWaitingSection.classList.add("hidden");
    
    guessPromptText.textContent = "Last Chance! Guess the word to win!";
    wordGuessInput.value = "";
    submitGuessBtn.disabled = false;
    submitGuessBtn.textContent = "Submit Guess";
    
    let remaining = timeLimit;
    guessTimerText.textContent = remaining + " seconds remaining";
    
    guessTimerInterval = setInterval(function() {
        remaining--;
        guessTimerText.textContent = remaining + " seconds remaining";
        if (remaining <= 0) {
            clearInterval(guessTimerInterval);
            guessTimerInterval = null;
        }
    }, 1000);
}

// Impostor guess prompt (for the eliminated impostor)
socket.on("impostorGuessPrompt", function(data) {
    showImpostorGuessInput(data.timeLimit);
});

// Impostor is guessing (for other players)
socket.on("impostorGuessing", function(data) {
    resultsSection.classList.add("hidden");
    impostorGuessSection.classList.remove("hidden");
    guessInputSection.classList.add("hidden");
    guessWaitingSection.classList.remove("hidden");
    
    guessPromptText.textContent = data.impostorName + " is guessing the word...";
    
    let remaining = data.timeLimit;
    guessTimerText.textContent = remaining + " seconds remaining";
    
    guessTimerInterval = setInterval(function() {
        remaining--;
        guessTimerText.textContent = remaining + " seconds remaining";
        if (remaining <= 0) {
            clearInterval(guessTimerInterval);
            guessTimerInterval = null;
        }
    }, 1000);
});

// Impostor guess result
socket.on("impostorGuessResult", function(data) {
    hideImpostorGuessSection();
    // Game ended event will follow
});

socket.on("gameEnded", function(data) {
    gameEnded = true;
    hideImpostorGuessSection();
    resultsSection.classList.add("hidden");
    nextRoundBtn.classList.add("hidden");
    resultsWaiting.classList.add("hidden");
    endedSection.classList.remove("hidden");
    
    if (data.winner === "crew") {
        endedCard.className = "rounded-xl p-6 sm:p-8 text-center bg-green-600";
        winnerText.textContent = "CREW WINS";
    } else {
        endedCard.className = "rounded-xl p-6 sm:p-8 text-center bg-red-600";
        winnerText.textContent = "IMPOSTORS WIN";
    }
    winReason.textContent = data.reason;
    phaseDisplay.textContent = "GAME OVER";
    updatePhaseHeader("ended");
    
    // Show play again button for host, waiting message for others
    if (isHost) {
        playAgainBtn.classList.remove("hidden");
        playAgainWaiting.classList.add("hidden");
    } else {
        playAgainBtn.classList.add("hidden");
        playAgainWaiting.classList.remove("hidden");
    }
});

// Game reset (play again)
socket.on("gameReset", function() {
    console.log("gameReset received");
    
    gameEnded = false;
    isEliminated = false;
    
    // Reset the play again button
    playAgainBtn.disabled = false;
    playAgainBtn.textContent = "Play Again";
    playAgainBtn.classList.add("hidden");
    playAgainWaiting.classList.add("hidden");
    
    // Hide game screen, show room screen
    gameDiv.classList.add("hidden");
    roomDiv.classList.remove("hidden");
    lobbyDiv.classList.add("hidden");
    
    roomCodeSpan.textContent = currentRoomCode;
    
    // Show start button for host
    if (isHost) {
        startBtn.classList.remove("hidden");
    } else {
        startBtn.classList.add("hidden");
    }
    
    modeSection.classList.remove("hidden");
    gameErrorP.textContent = "";
    
    socket.emit("getCategories");
    
    console.log("gameReset complete, showing room:", currentRoomCode);
});

socket.on("roleAssigned", function(data) {
    categoryInfo.textContent = "Category: " + data.category;
    
    if (data.role === "impostor") {
        roleCard.className = "rounded-xl p-4 sm:p-6 text-center bg-red-600";
        roleDisplay.textContent = "You are the IMPOSTOR";
        wordDisplay.textContent = "";
        roleHint.textContent = "You do not receive the secret word. Blend in!";
        roleHint.classList.remove("hidden");
    } else {
        roleCard.className = "rounded-xl p-4 sm:p-6 text-center bg-green-600";
        roleDisplay.textContent = "You are CREW";
        wordDisplay.textContent = data.word;
        roleHint.classList.add("hidden");
    }
});
