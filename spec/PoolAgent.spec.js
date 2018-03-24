const mysql = require('mysql2/promise');

const Nimiq = require('../../core/dist/node.js');

const PoolAgent = require('../PoolAgent.js');
const PoolServer = require('../PoolServer.js');

describe('PoolAgent', () => {

    beforeEach(() => {
        spyOn(PoolServer, 'createServer').and.callFake(() => {
            return {
                on: () => {},
                close: () => {}
            };
        });
    });

    it('correctly verifies and stores shares', (done) => {
        (async () => {
            const garbageShare1 = {
                message: 'share',
                blockHeader: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX9vP0kWw2ehDhyZrt7mbp7y8dkxMp4KIjEpdLxJfYomC9+lsDk69Zf1nKgo310WjztIlWoXqrKJBpOmax/TKYmUgg1ePrhcc81yOoL2NveUQvWCC7UfeaU9Ef3x4a2d0AAAHOWr1epwAANcg=',
                minerAddrProof: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==',
                extraDataProof: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
            };
            const garbageShare2 = {
                message: 'share',
                minerAddrProof: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==',
                extraDataProof: 'AAAAAAAAAAAAA=='
            };
            const extraDataMismatchShare = {
                message: 'share',
                blockHeader: 'AAEjqNjlGed8sW5w3MHOYWeZYh9tZ9hHo07V6PC40fCftKTe8QpX9vP0kWw2ehDhyZrt7mbp7y8dkxMp4KIjEpdLxJfYomC9+lsDk69Zf1nKgo310WjztIlWoXqrKJBpOmax/TKYmUgg1ePrhcc81yOoL2NveUQvWCC7UfeaU9Ef3x4a2d0AAAHOWr1epwAANcg=',
                minerAddrProof: 'AQDlGaxZpleczKa6WIz5+1/4AxGSr4uTnIyBM7xD89NDXA==',
                extraDataProof: 'AYBoy7UwGcq2H2DloO+IEJ+gvcoXl4Lw3IbMc1gL8MPq/w=='
            };
            const minerAddressMismatchShare = {
                message: 'share',
                blockHeader: 'AAEao0Yxsa962l4lqQ2lWPTQLE/S+DiIUEFBB6PsqzLNpFJRcO9AkhiXHwbQmYBVa3wl3IcHzGB6sEq4bsJkN8GQ5TnDJnw0YST/BRpG7iyJGggU4nauzbm+3/hv7G6/HwneH/cwC+QhIf2esM+sr8gUs6DGP4OATDX2SoozCpIP7B4ite4AAAHxWr1u6gAAgHg=',
                minerAddrProof: 'AQCic/xMww3yGO8E7d+KUgb9+v5dD+K9rftj6TrDSNkEjQ==',
                extraDataProof: 'AYBR8HvTe2g7l1sgSQNgAzJayWYFO8LiWauJFCtR6ZNJpw=='
            };

            const consensus = await Nimiq.Consensus.volatileFull();
            const poolServer = new PoolServer(consensus, 'Test Pool', POOL_ADDRESS, 9999);
            await poolServer.start();
            const poolAgent = new PoolAgent(poolServer, { close: () => {}, send: () => {}, _socket: { remoteAddress: '1.2.3.4' } });
            spyOn(poolAgent, '_regenerateNonce').and.callFake(() => { poolAgent._nonce = 0 });
            await poolAgent._onMessage(NQ25sampleData.register);

            const userId = await poolServer.getStoreUserId(NQ25sampleData.address);

            await poolAgent._onMessage(NQ25sampleData.validShare_1);
            let hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(NQ25sampleData.validShare_1.blockHeader)).hash();
            expect(await poolServer.containsShare(userId, hash)).toBeTruthy();

            // await poolAgent._onMessage(garbageShare1);
            // hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(garbageShare1.blockHeader)).hash();
            // expect(await poolServer.containsShare(userId, hash)).toBeFalsy();
            //
            // await poolAgent._onMessage(garbageShare2);
            // hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(garbageShare2.blockHeader)).hash();
            // expect(await poolServer.containsShare(userId, hash)).toBeFalsy();

            await poolAgent._onMessage(extraDataMismatchShare);
            hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(extraDataMismatchShare.blockHeader)).hash();
            expect(await poolServer.containsShare(userId, hash)).toBeFalsy();

            await poolAgent._onMessage(minerAddressMismatchShare);
            hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(minerAddressMismatchShare.blockHeader)).hash();
            expect(await poolServer.containsShare(userId, hash)).toBeFalsy();

            done();
        })().catch(done.fail);
    });

    it('does not count shares onto old blocks', (done) => {
        (async () => {
            const consensus = await Nimiq.Consensus.volatileFull();
            const poolServer = new PoolServer(consensus, 'Test Pool', POOL_ADDRESS, 9999);
            await poolServer.start();
            const poolAgent = new PoolAgent(poolServer, { close: () => {}, send: () => {}, _socket: { remoteAddress: '1.2.3.4' } });
            spyOn(poolAgent, '_regenerateNonce').and.callFake(() => { poolAgent._nonce = 0 });
            await poolAgent._onMessage(NQ25sampleData.register);
            const userId = await poolServer.getStoreUserId(NQ25sampleData.address);

            await poolAgent._onMessage(NQ25sampleData.validShare_1);
            let hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(NQ25sampleData.validShare_1.blockHeader)).hash();
            expect(await poolServer.containsShare(userId, hash)).toBeTruthy();

            await consensus.blockchain.pushBlock(ChainSampleData.block1);

            await poolAgent._onMessage(NQ25sampleData.validShare_2);
            hash = Nimiq.BlockHeader.unserialize(Nimiq.BufferUtils.fromBase64(NQ25sampleData.validShare_2.blockHeader)).hash();
            expect(await poolServer.containsShare(userId, hash)).toBeFalsy();

            done();
        })().catch(done.fail);
    });

    it('handles balance requests', (done) => {
        (async () => {
            const consensus = await Nimiq.Consensus.volatileFull();
            const poolServer = new PoolServer(consensus, 'Test Pool', POOL_ADDRESS, 9999);
            await poolServer.start();
            const poolAgent = new PoolAgent(poolServer, {
                close: () => {},
                send: (m) => {
                    msg = JSON.parse(m);
                    if (msg.message === PoolAgent.MESSAGE_BALANCE_RESPONSE) {
                        expect(msg.balance === 0).toBeTruthy();
                        expect(msg.virtualBalance === 3).toBeTruthy();
                        done();
                    }
                },
                _socket: {
                    remoteAddress: '1.2.3.4'
                }
            });
            await poolAgent._onMessage(NQ25sampleData.register);
            const userId = await poolServer.getStoreUserId(NQ25sampleData.address);

            connection = await mysql.createConnection({ host: 'localhost', user: 'root', password: 'root', database: 'nimpool', multipleStatements: true });
            await connection.execute('INSERT INTO payin (user, amount, datetime, block) VALUES (?, ?, ?, ?)', [userId, 5, Date.now(), 1]);
            await connection.execute('INSERT INTO payout (user, amount, datetime, transaction) VALUES (?, ?, ?, ?)', [userId, 2, Date.now(), 'lkghdjdf']);
            await connection.execute('INSERT INTO block (id, hash, height) VALUES (?, ?, ?)', ['1', 'lsdjf', 0]);

            await poolAgent._onMessage({ message: 'balance-request' });
        })().catch(done.fail);
    });

    it('handles payout requests', (done) => {
        (async () => {
            const keyPair = Nimiq.KeyPair.generate();
            const clientAddress = keyPair.publicKey.toAddress();

            const consensus = await Nimiq.Consensus.volatileFull();
            const poolServer = new PoolServer(consensus, 'Test Pool', POOL_ADDRESS, 9999);
            await poolServer.start();
            const poolAgent = new PoolAgent(poolServer, { close: () => {}, send: () => {}, _socket: { remoteAddress: '1.2.3.4' } });
            spyOn(poolAgent, '_regenerateNonce').and.callFake(() => { poolAgent._nonce = 42 });

            const registerMsg = {
                message: 'register',
                address: clientAddress.toUserFriendlyAddress(),
                deviceId: 1111111111
            };
            await poolAgent._onMessage(registerMsg);

            async function sendSignedPayoutRequest(usedKeyPair) {
                let buf = new Nimiq.SerialBuffer(8 + PoolAgent.PAYOUT_NONCE_PREFIX.length);
                buf.writeString(PoolAgent.PAYOUT_NONCE_PREFIX, PoolAgent.PAYOUT_NONCE_PREFIX.length);
                buf.writeUint64(42);
                let signature = Nimiq.Signature.create(usedKeyPair.privateKey, usedKeyPair.publicKey, buf);
                return Nimiq.SignatureProof.singleSig(usedKeyPair.publicKey, signature);
            }

            // garbage signature
            let request = { message: 'payout', proof: 'AAAAAAAAAAAAAAAAAAaaaaaaaa' };
            await poolAgent._onMessageData(JSON.stringify(request));

            connection = await mysql.createConnection({ host: 'localhost', user: 'root', password: 'root', database: 'nimpool', multipleStatements: true });
            let userId = await poolServer.getStoreUserId(clientAddress);
            let [rows, fields] = await connection.execute('SELECT * FROM payout_request WHERE user=?', [userId]);
            expect(rows.length).toEqual(0);

            // invalid signature
            signatureProof = await sendSignedPayoutRequest(Nimiq.KeyPair.generate());
            request = { message: 'payout', proof: signatureProof.serialize() };
            await poolAgent._onMessage(request);

            userId = await poolServer.getStoreUserId(clientAddress);
            [rows, fields] = await connection.execute('SELECT * FROM payout_request WHERE user=?', [userId]);
            expect(rows.length).toEqual(0);

            // valid signature
            signatureProof = await sendSignedPayoutRequest(keyPair);
            request = { message: 'payout', proof: signatureProof.serialize() };
            await poolAgent._onMessage(request);

            userId = await poolServer.getStoreUserId(clientAddress);
            [rows, fields] = await connection.execute('SELECT * FROM payout_request WHERE user=?', [userId]);
            expect(rows.length).toEqual(1);

            done();
        })().catch(done.fail);
    });
});
