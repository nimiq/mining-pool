const fs = require('fs');
const mysql = require('mysql2/promise');

const Nimiq = require('@nimiq/core');

const PoolPayout = require('../src/PoolPayout.js');

describe('PoolPayout', () => {

    xit('processes payins', (done) => {
        (async () => {
            const connection = await mysql.createConnection({ host: 'localhost', user: 'root', password: 'root', database: 'pool', multipleStatements: true });
            await connection.execute('INSERT INTO block (id, hash, height) VALUES (?, ?, ?)', [1, 'a', 1]);
            await connection.execute('INSERT INTO block (id, hash, height) VALUES (?, ?, ?)', [2, 'b', 2]);

            await connection.execute('INSERT INTO user (id, address) VALUES (?, ?)', [1, Nimiq.Address.fromUserFriendlyAddress('NQ25 FGPF A68A TBQ4 7KUU 3TFG 418D 1J49 HRLN').toBase64()]);
            await connection.execute('INSERT INTO user (id, address) VALUES (?, ?)', [2, Nimiq.Address.fromUserFriendlyAddress('NQ43 SXSE XAS0 HYXJ M1U4 DCJ3 0SXE 8KUH 5DU7').toBase64()]);

            await connection.execute('INSERT INTO payin (user, amount, datetime, block) VALUES (?, ?, ?, ?)', [1, 5 * Nimiq.Policy.SATOSHIS_PER_COIN, Date.now(), 1]);
            await connection.execute('INSERT INTO payin (user, amount, datetime, block) VALUES (?, ?, ?, ?)', [2, 4 * Nimiq.Policy.SATOSHIS_PER_COIN, Date.now(), 1]);

            await connection.execute('INSERT INTO payin (user, amount, datetime, block) VALUES (?, ?, ?, ?)', [1, 4 * Nimiq.Policy.SATOSHIS_PER_COIN, Date.now(), 2]);
            await connection.execute('INSERT INTO payin (user, amount, datetime, block) VALUES (?, ?, ?, ?)', [2, 12 * Nimiq.Policy.SATOSHIS_PER_COIN, Date.now(), 2]);

            POOL_CONFIG.payoutConfirmations = 4;

            const consensus = await Nimiq.Consensus.volatileFull();
            await consensus.blockchain.pushBlock(ChainSampleData.block1);
            await consensus.blockchain.pushBlock(ChainSampleData.block2);
            await consensus.blockchain.pushBlock(ChainSampleData.block3);
            await consensus.blockchain.pushBlock(ChainSampleData.block4);

            const walletStore = await new Nimiq.WalletStore();
            const wallet = await walletStore.getDefault();
            const poolPayout = new PoolPayout(consensus, wallet, POOL_CONFIG);
            await poolPayout.start();
            await poolPayout._processPayouts();

            let [rows, fields] = await connection.execute('SELECT * FROM payout');
            expect(rows.length).toEqual(2);
            [rows, fields] = await connection.execute('SELECT * FROM payout WHERE user=?', [1]);
            expect(rows.length).toEqual(1);
            expect(rows[0].amount).toEqual((5) * Nimiq.Policy.SATOSHIS_PER_COIN);
            [rows, fields] = await connection.execute('SELECT * FROM payout WHERE user=?', [2]);
            expect(rows.length).toEqual(1);
            expect(rows[0].amount).toEqual((4) * Nimiq.Policy.SATOSHIS_PER_COIN);

            await consensus.blockchain.pushBlock(ChainSampleData.block5);

            await poolPayout._processPayouts();

            [rows, fields] = await connection.execute('SELECT * FROM payout');
            expect(rows.length).toEqual(4);
            [rows, fields] = await connection.execute('SELECT sum(amount) as sum FROM payout WHERE user=?', [1]);
            expect(rows[0].sum).toEqual((5+4) * Nimiq.Policy.SATOSHIS_PER_COIN);
            [rows, fields] = await connection.execute('SELECT sum(amount) as sum FROM payout WHERE user=?', [2]);
            expect(rows[0].sum).toEqual((4+12) * Nimiq.Policy.SATOSHIS_PER_COIN);

            done();
        })().catch(done.fail);
    });
});
