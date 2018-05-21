/**
 * NOTE: Don't modify this file! Copy this file to `evenHandlers.js` and it will
 *   automatically be included in the pool server!
 */

/**
 * Fired when a REGISTER message is received, before being processed by the
 *   PoolAgent. Good time to perform validation or mutation of message data.
 * @param {PoolAgent} agent - The Agent for the newly registered device.
 * @param {Object} msg - The full register message. This is not a copy; any
 *   mutation will affect the data used to create the PoolAgent.
 * @param {mysql.PoolConnection} connectionPool - A MySQL connection pool,
 *   logged in as 'pool_server'.
 * @throws {Error} Should throw an Error with a message to send to the device
 *   if registration should not continue.
 * @returns {void}
 */
module.exports.onRegisterMessage = function onRegisterMessage(agent, msg, connectionPool) { }

/**
 * Fired when a new PoolAgent is registered to the PoolServer.
 * @param {PoolAgent} agent - The Agent for the newly registered device.
 * @param {mysql.PoolConnection} connectionPool - A MySQL connection pool,
 *   logged in as 'pool_server'.
 * @returns {void}
 */
module.exports.onRegistrationCompleted = async function onRegistrationCompleted(agent, connectionPool) { }
