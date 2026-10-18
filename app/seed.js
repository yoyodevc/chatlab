// Generates app/data.json with bcrypt-hashed passwords. Run: node scripts/seed.js
// Run from app/.
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

const seed = [
  ['alice', 'admin', 'alice-pass-1'],
  ['bob', 'member', 'bob-pass-2'],
  ['carol', 'member', 'carol-pass-3'],
  ['guest1', 'guest', 'guest-pass-4'],
];
const data = {
  users: seed.map(([username, role, pw]) => ({ username, role, passwordHash: bcrypt.hashSync(pw, 10) })),
  rooms: {
    general: { members: ['alice', 'bob', 'carol', 'guest1'] },
    dev: { members: ['alice', 'bob'] },
  },
  messages: [
    { id: 'msg_1', room: 'general', from: 'bob', text: 'Hi', ts: '2026-10-13T05:40:12Z' },
    { id: 'msg_2', room: 'general', from: 'carol', text: 'Hello everyone', ts: '2026-10-13T05:41:03Z' },
    { id: 'msg_3', room: 'dev', from: 'bob', text: 'Build is green', ts: '2026-10-13T05:42:30Z' },
  ],
};
fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(data, null, 2));
console.log('wrote app/data.json');
