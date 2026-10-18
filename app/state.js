// In-memory state loaded from the seed file. Shared by server.js, auth.js and authz.js.
const data = JSON.parse(JSON.stringify(require('./data.json')));

module.exports = {
  users: data.users,
  rooms: data.rooms,       // { name: { members: [username] } }
  messages: data.messages, // [{ id, room, from, text, ts }]
  nextId: data.messages.length + 1,
};
