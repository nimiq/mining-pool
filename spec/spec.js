const fs = require('fs');
const mysql = require('mysql2/promise');
const Nimiq = require('@nimiq/core');

NETCONFIG = new Nimiq.WsNetworkConfig('node1.test', 9000, 'key1', 'cert1');
NETCONFIG._keyPair = Nimiq.KeyPair.fromHex('ab05e735f870ff4482a997eab757ea78f8a83356ea443ac68969824184b82903a5ea83e7ee0c8c7ad863c3ceffd31a63679e1ea34a5f89e3ae0f90c5d281d4a900');

/** @type {PoolConfig} */
POOL_CONFIG = require('../src/Config.js').DEFAULT_CONFIG.pool;
POOL_CONFIG.name = 'Test Pool';
POOL_CONFIG.address = 'NQ10 G2P1 GKKY TMUX YLRH BF8D 499N LD9G B1HX';

Nimiq.GenesisConfig.CONFIGS['tests'] = {
    NETWORK_ID: 4,
    NETWORK_NAME: 'tests',
    GENESIS_BLOCK: new Nimiq.Block(
        new Nimiq.BlockHeader(
            new Nimiq.Hash(null),
            new Nimiq.Hash(null),
            Nimiq.Hash.fromBase64('nVtxMP3RlCdAbx1Hd4jsH4ZsZQsu/1UK+zUFsUNWgbs='),
            Nimiq.Hash.fromBase64('v6zYHGQ3Z/O/G/ZCyXtO/TPa7/Kw00HGEzRK5wbu2zg='),
            Nimiq.BlockUtils.difficultyToCompact(1),
            1,
            0,
            101720,
            Nimiq.BlockHeader.Version.V1),
        new Nimiq.BlockInterlink([], new Nimiq.Hash(null)),
        new Nimiq.BlockBody(Nimiq.Address.fromBase64('G+RAkZY0pv47pfinGB/ku4ISwTw='), [])
    ),
    GENESIS_ACCOUNTS: 'AAIP7R94Gl77Xrk4xvszHLBXdCzC9AAAAHKYqT3gAAh2jadJcsL852C50iDDRIdlFjsNAAAAcpipPeAA',
    SEED_PEERS: [Nimiq.WsPeerAddress.seed('node1.test', 9000, NETCONFIG.publicKey.toHex())]
};
Nimiq.GenesisConfig.init(Nimiq.GenesisConfig.CONFIGS['tests']);

async function dropDatabase() {
    try {
        const data = fs.readFileSync('./sql/drop.sql', 'utf8');
        const connection = await mysql.createConnection({
            host: 'localhost',
            user: 'root',
            password: 'root',
            multipleStatements: true
        });
        await connection.query(data);
        await connection.close();
    } catch (e) {
        // Ignore, this is supposed to happen if prior tests did fail.
    }
}

async function createDatabase() {
    const connection = await mysql.createConnection({host: 'localhost', user: 'root', password: 'root'});
    const data = fs.readFileSync('./sql/create.sql', 'utf8');
    let start = 0;
    let length = 0;
    let delimiter = ';';
    while (start < data.length) {
        let nextDelimiter = data.indexOf(delimiter, start);
        let nextDelimiterChange = data.indexOf('\nDELIMITER', start);
        if (nextDelimiter < 0) nextDelimiter = data.length;
        if (nextDelimiterChange < 0) nextDelimiterChange = Number.MAX_VALUE;

        if (nextDelimiterChange < nextDelimiter) {
            const delimiterChangeEnd = data.indexOf('\n', nextDelimiterChange + 11);
            delimiter = data.substring(nextDelimiterChange + 11, delimiterChangeEnd);
            start = delimiterChangeEnd + 1;
        } else {
            const query = data.substring(start, nextDelimiter);
            if (query.trim() != '') {
                await connection.query(query);
            }
            start = nextDelimiter + delimiter.length;
        }
    }
    await connection.close();
}

beforeAll((done) => {
    dropDatabase().then(done, done.fail);
});

beforeEach((done) => {
    createDatabase().then(done, done.fail);
});

afterEach((done) => {
    dropDatabase().then(done, done.fail);
});

jasmine.DEFAULT_TIMEOUT_INTERVAL = 12000;

const ChainSampleData = require('./ChainSampleData.spec.js');
const NQ25sampleData = require('./NQ25sampleData.spec.js');
const NQ43sampleData = require('./NQ43sampleData.spec.js');
