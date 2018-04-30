const fs = require('fs');
const JSON5 = require('json5');
const merge = require('lodash.merge');

const Log = require('@nimiq/core').Log;
const TAG = 'Config';

/**
 * @typedef {object} PoolConfig
 * @property {string} name
 * @property {string} address
 * @property {number} payoutConfirmations
 * @property {number} autoPayOutLimit
 * @property {number} poolFee
 * @property {number} networkFee
 * @property {number} minDifficulty
 * @property {number} spsTimeUnit
 * @property {number} desiredSps
 * @property {number} connectionTimeout
 * @property {number} pplnsShares
 */

/**
 * @typedef {object} Config
 * @property {string} host
 * @property {{cert: string, key: string}} tls
 * @property {number} port
 * @property {boolean} dumb
 * @property {string} type
 * @property {string} network
 * @property {PoolConfig} pool
 * @property {{enabled: boolean, port: number, sslCertPath: string, sslKeyPath: string, mySqlPsw: string, mySqlHost: string}} poolServer
 * @property {{enabled: boolean, mySqlPsw: string, mySqlHost: string}} poolService
 * @property {{enabled: boolean, mySqlPsw: string, mySqlHost: string}} poolPayout
 * @property {{seed: string, address: string}} wallet
 * @property {{level: string, tags: object}} log
 * @property {Array.<{host: string, port: number, publicKey: string}>} seedPeers
 * @property {object} constantOverrides
 */

const DEFAULT_CONFIG = /** @type {Config} */ {
    host: null,
    tls: {
        cert: null,
        key: null
    },
    port: 8443,
    dumb: false,
    type: 'full',
    network: 'main',
    pool: {
        name: null,
        address: null,
        payoutConfirmations: 10,
        autoPayOutLimit: 5000000, // 50 NIM
        poolFee: 0.01, // 1%
        networkFee: 1, // satoshi per byte
        minDifficulty: 1,
        spsTimeUnit: 60000, // 1 minute
        desiredSps: 0.2, // desired shares per second
        connectionTimeout: 60 * 1000 * 10, // 10 minutes
        pplnsShares: 1000,
        allowedErrors: 3
    },
    poolServer: {
        enabled: false,
        port: 8444,
        sslCertPath: null,
        sslKeyPath: null,
        mySqlPsw: null,
        mySqlHost: null
    },
    poolService: {
        enabled: false,
        mySqlPsw: null,
        mySqlHost: null
    },
    poolPayout: {
        enabled: false,
        mySqlPsw: null,
        mySqlHost: null
    },
    poolMetricsServer: {
        enabled: false,
        port: 8650,
        password: null
    },
    wallet: {
        seed: null,
    },
    log: {
        level: 'info',
        tags: {}
    },
    seedPeers: [],
    constantOverrides: {}
};

const CONFIG_TYPES = {
    host: 'string',
    tls: {
        type: 'object', sub: {
            cert: 'string',
            key: 'string'
        }
    },
    port: 'number',
    dumb: 'boolean',
    type: {type: 'string', values: ['full', 'light', 'nano']},
    network: 'string',
    statistics: 'number',
    pool: {
        type: 'object', sub: {
            name: 'string',
            address: 'string',
            payoutConfirmations: 'number',
            autoPayOutLimit: 'number',
            poolFee: 'number',
            networkFee: 'number',
            minDifficulty: 'number',
            spsTimeUnit: 'number',
            desiredSps: 'number',
            connectionTimeout: 'number',
            pplnsShares: 'number',
            allowedErrors: 'number'
        }
    },
    poolServer: {
        type: 'object', sub: {
            enabled: 'boolean',
            port: 'number',
            certPath: 'string',
            keyPath: 'string',
            mySqlPsw: 'string',
            mySqlHost: 'string'
        }
    },
    poolService: {
        type: 'object', sub: {
            enabled: 'boolean',
            mySqlPsw: 'string',
            mySqlHost: 'string'
        }
    },
    poolPayout: {
        type: 'object', sub: {
            enabled: 'boolean',
            mySqlPsw: 'string',
            mySqlHost: 'string'
        }
    },
    poolMetricsServer: {
        type: 'object', sub: {
            enabled: 'boolean',
            port: 'number',
            password: 'string'
        }
    },
    wallet: {
        type: 'object', sub: {
            seed: 'string',
        }
    },
    log: {
        type: 'object', sub: {
            level: {type: 'string', values: ['trace', 'verbose', 'debug', 'info', 'warning', 'error', 'assert']},
            tags: 'object'
        }
    },
    seedPeers: {
        type: 'array', inner: {
            type: 'object', sub: {
                host: 'string',
                port: 'number',
                publicKey: 'string'
            }
        }
    },
    constantOverrides: 'object'
};

function validateItemType(config, key, type, error = true) {
    let valid = true;
    if (typeof type === 'string') {
        if (type === 'boolean') {
            if (config[key] === 'yes' || config[key] === 1) config[key] = true;
            if (config[key] === 'no' || config[key] === 0) config[key] = false;
        }
        if (type === 'number' && typeof config[key] === 'string') {
            if (!isNaN(parseInt(config[key]))) {
                Log.i(TAG, `Configuration option '${key}' should be of type 'number', but is of type 'string', will parse it.`);
                config[key] = parseInt(config[key]);
            }
        }
        if (type === 'string' && typeof config[key] === 'number') {
            Log.i(TAG, `Configuration option '${key}' should be of type 'string', but is of type 'number', will convert it.`);
            config[key] = config[key].toString();
        }
        if (typeof config[key] !== type) {
            if (error) Log.w(TAG, `Configuration option '${key}' is of type '${typeof config[key]}', but '${type}' is required`);
            valid = false;
        }
    } else if (typeof type === 'object') {
        if (['string', 'number', 'object'].includes(type.type)) {
            if (!validateItemType(config, key, type.type)) {
                valid = false;
            }
        }
        if (type.type === 'array') {
            if (!Array.isArray(config[key])) {
                if (error) Log.w(TAG, `Configuration option '${key}' should be an array.`);
                valid = false;
            } else if (type.inner) {
                for (let i = 0; i < config[key].length; i++) {
                    if (!validateItemType(config[key], i, type.inner, false)) {
                        if (error) Log.w(TAG, `Element ${i} of configuration option '${key}' is invalid.`);
                        valid = false;
                    }
                }
            }
        }
        if (Array.isArray(type.values)) {
            if (!type.values.includes(config[key])) {
                if (error) Log.w(TAG, `Configuration option '${key}' is '${config[key]}', but must be one of '${type.values.slice(0, type.values.length - 1).join('\', \'')}' or '${type.values[type.values.length - 1]}'.`);
                valid = false;
            }
        }
        if (typeof config[key] === 'object' && type.type === 'object' && typeof type.sub === 'object') {
            if (!validateObjectType(config[key], type.sub, error)) {
                valid = false;
            }
        }
        if (type.type === 'mixed' && Array.isArray(type.types)) {
            let subvalid = false;
            for (const subtype of type.types) {
                if (validateItemType(config, key, subtype, false)) {
                    subvalid = true;
                    break;
                }
            }
            if (!subvalid) {
                if (error) Log.w(TAG, `Configuration option '${key}' is invalid`);
                valid = false;
            }
        }
    }
    return valid;
}

function validateObjectType(config, types = CONFIG_TYPES, error = true) {
    let valid = true;
    for (const key in types) {
        if (!(key in config) || config[key] === undefined || config[key] === null) {
            if (typeof types[key] === 'object' && types[key].required) {
                if (error) Log.w(TAG, `Required configuration option '${key}' is missing`);
                valid = false;
            }
            continue;
        }
        if (!validateItemType(config, key, types[key], error)) {
            valid = false;
        }
    }
    return valid;
}

if (!validateObjectType(DEFAULT_CONFIG)) {
    throw new Error('Default config is invalid according to type specification.');
}

/**
 * @param {string} file
 * @param {object} oldConfig
 * @returns {Config|boolean}
 */
function readFromFile(file, oldConfig = merge({}, DEFAULT_CONFIG)) {
    if (typeof file === 'undefined') {
        Log.e(TAG, 'No configuration file given');
        return false;
    }
    try {
        const config = JSON5.parse(fs.readFileSync(file));
        if (!validateObjectType(config)) {
            Log.e(TAG, `Configuration file ${file} is invalid.`);
            return false;
        } else {
            return merge(oldConfig, config);
        }
    } catch (e) {
        Log.e(TAG, `Failed to read file ${file}: ${e.message}`);
        return false;
    }
}

module.exports = readFromFile;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
