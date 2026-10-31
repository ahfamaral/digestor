# secrets/

Files here are git-ignored and kept out of Docker images. The worker mounts this folder read-only at `/secrets`.

- `youtube-cookies.txt`: optional YouTube cookies for server downloads (Netscape format). Set `YTDLP_COOKIES_FILE=/secrets/youtube-cookies.txt` in `.env`; see `docs/deploy.md` → "YouTube links on a server".
