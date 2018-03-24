const Nimiq = require('../../core/dist/node.js');

NQ43sampleData = {};

NQ43sampleData.address = Nimiq.Address.fromUserFriendlyAddress('NQ43 SXSE XAS0 HYXJ M1U4 DCJ3 0SXE 8KUH 5DU7');

NQ43sampleData.register = {
    message: 'register',
    address: 'NQ43 SXSE XAS0 HYXJ M1U4 DCJ3 0SXE 8KUH 5DU7',
    deviceId: 1513202621
};

// extra_data
// {
//     message: 'settings',
//     address: 'NQ10 G2P1 GKKY TMUX YLRH BF8D 499N LD9G B1HX',
//     extraData: 'VGVzdCBQb29sANe07ytAj/0qh4RrJDBrzkT5EreHAAAAAB8BAAA=',
//     target: 1.7668470647783843e+72,
//     nonce: 0
// }

/** Onto: Genesis*/
NQ43sampleData.validShare_1 = {
    message: 'share',
    blockHeader: 'AAH6/T8cyAAwnLkxCBJXtOftsPnqQAGHxVD9kUFEfqCGpZEzwRF7tseL/hGulqbi1xtu7ih6/xnc1EUAx+iXQJZRS36SQ+ILlqy5MPFZdxDq2AAmkxKoRVVeoi7AzQicjzlsfaKhCoweRBsyqJEgb7br+BaYlE4HG7kVCdp1Oi5FIx8BAAAAAAACABt3QAABp24=',
    minerAddrProof: 'AQDuz4j+JjCSQWO3CB6mRFVRhD+LcGJY3JYrJ2i6g5ic5A==',
    extraDataProof: 'AYBoy7UwGcq2H2DloO+IEJ+gvcoXl4Lw3IbMc1gL8MPq/w=='
};

/** Onto: Genesis*/
NQ43sampleData.validShare_2 = {
    message: 'share',
    blockHeader: 'AAH6/T8cyAAwnLkxCBJXtOftsPnqQAGHxVD9kUFEfqCGpZEzwRF7tseL/hGulqbi1xtu7ih6/xnc1EUAx+iXQJZRS36SQ+ILlqy5MPFZdxDq2AAmkxKoRVVeoi7AzQicjzlsfaKhCoweRBsyqJEgb7br+BaYlE4HG7kVCdp1Oi5FIx8BAAAAAAACAAAHCAAAe1I=',
    minerAddrProof: 'AQDuz4j+JjCSQWO3CB6mRFVRhD+LcGJY3JYrJ2i6g5ic5A==',
    extraDataProof: 'AYBoy7UwGcq2H2DloO+IEJ+gvcoXl4Lw3IbMc1gL8MPq/w=='
};

/** Onto: Genesis*/
NQ43sampleData.validShare_3 = {
    message: 'share',
    blockHeader: 'AAH6/T8cyAAwnLkxCBJXtOftsPnqQAGHxVD9kUFEfqCGpZEzwRF7tseL/hGulqbi1xtu7ih6/xnc1EUAx+iXQJZRS36SQ+ILlqy5MPFZdxDq2AAmkxKoRVVeoi7AzQicjzlsfaKhCoweRBsyqJEgb7br+BaYlE4HG7kVCdp1Oi5FIx8BAAAAAAACAAAAAQAAJTQ=',
    minerAddrProof: 'AQDuz4j+JjCSQWO3CB6mRFVRhD+LcGJY3JYrJ2i6g5ic5A==',
    extraDataProof: 'AYBoy7UwGcq2H2DloO+IEJ+gvcoXl4Lw3IbMc1gL8MPq/w=='
};
module.exports = exports = NQ43sampleData;
