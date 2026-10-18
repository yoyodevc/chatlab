// All permission rules live here (see lab section 4.2).
const state = require('./state');

// action: join | send | create | delete | remove
// room:   room name (for join/send/remove)
// msg:    message object (for delete)
//
// Role comes from the JWT, but membership is read live from state, so removing a
// member from a room takes effect immediately.
function can(user, action, room, msg) {
  if (user.role === 'admin') return true;
  const inRoom = !!state.rooms[room]?.members.includes(user.sub);
  switch (action) {
    case 'join':   return user.role === 'guest' ? room === 'general' : inRoom;
    case 'send':   return user.role === 'member' && inRoom;
    case 'delete': return user.role === 'member' && !!msg && msg.from === user.sub;
    case 'create': return false;
    case 'remove': return false;
    default:       return false;
  }
}

module.exports = { can };
