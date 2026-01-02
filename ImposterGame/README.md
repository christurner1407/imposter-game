# Impostor Game

A real-time multiplayer social deduction game built with Node.js, Express, and Socket.IO.

## Features

- **Real-time multiplayer** - Play with friends using a 4-letter room code
- **Multiple impostors** - Support for 1-3 impostors per game
- **Preset & custom words** - Choose from categories or create your own word list
- **Last-chance guess** - Eliminated impostors get 30 seconds to guess the secret word
- **Play again** - Restart without leaving the room
- **Mobile-friendly** - Responsive UI with touch-friendly controls
- **Secure** - Rate limiting, input validation, and CORS protection

## How to Play

1. One player creates a session and shares the 4-letter code
2. Other players join using the code
3. Host selects a category and number of impostors
4. Host starts the game - roles are assigned secretly
5. **Crew** sees the secret word, **Impostors** do not
6. Discuss and try to identify who doesn't know the word
7. Vote to eliminate suspects
8. **Crew wins** if all impostors are eliminated
9. **Impostors win** if they equal or outnumber the crew

## Installation

```bash
# Clone the repository
git clone https://github.com/christurner1407/imposter-game.git
cd imposter-game/ImposterGame

# Install dependencies
npm install

# Start the server
node app.js
```

The game will be available at `http://localhost:3000`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `ALLOWED_ORIGINS` | localhost | Comma-separated list of allowed CORS origins |

## Tech Stack

- **Backend**: Node.js, Express, Socket.IO
- **Frontend**: HTML, Tailwind CSS, Vanilla JavaScript
- **Security**: Helmet, express-rate-limit

## Security Features

- HTTP security headers (Helmet)
- Rate limiting per IP and per socket event
- Input validation (names, room codes, votes)
- CORS origin restrictions
- Auto-cleanup of inactive rooms (30 min timeout)
- Max 100 rooms, 20 players per room

## License

MIT
