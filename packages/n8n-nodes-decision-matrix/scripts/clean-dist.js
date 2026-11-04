const fs = require('fs');
const path = require('path');

// Empty dist/ but keep the directory. docker-compose bind-mounts it into n8n,
// and Docker Desktop keeps the mount on the original directory. Deleting and
// recreating dist/ leaves the container pointing at a directory that no longer
// exists, and it cannot restart.
const dist = path.join(__dirname, '..', 'dist');
fs.mkdirSync(dist, { recursive: true });
for (const entry of fs.readdirSync(dist)) {
	fs.rmSync(path.join(dist, entry), { recursive: true, force: true });
}
