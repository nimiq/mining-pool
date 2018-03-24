const Nimiq = require('../../core/dist/node.js');

NQ25sampleData = {};

NQ25sampleData.address = Nimiq.Address.fromUserFriendlyAddress('NQ25 FGPF A68A TBQ4 7KUU 3TFG 418D 1J49 HRLN');

NQ25sampleData.register = {
    message: 'register',
    address: 'NQ25 FGPF A68A TBQ4 7KUU 3TFG 418D 1J49 HRLN',
    deviceId: 1513202621
};

// extra_data
// {
//     message: 'settings',
//     address: 'NQ10 G2P1 GKKY TMUX YLRH BF8D 499N LD9G B1HX',
//     extraData: 'VGVzdCBQb29sAHwu9RkK2vBDz5we3wIFDQyImOaWAAAAAB8BAAA=',
//     target: 1.7668470647783843e+72,
//     nonce: 0
// }

/** Onto: Genesis*/
NQ25sampleData.validShare_1 = {
    message: 'share',
    blockHeader: 'AAH6/T8cyAAwnLkxCBJXtOftsPnqQAGHxVD9kUFEfqCGpZEzwRF7tseL/hGulqbi1xtu7ih6/xnc1EUAx+iXQJZRoF++Si5RVTM8WmqTzeN/gptHD+0bM3YceOrIxGprvLZsfaKhCoweRBsyqJEgb7br+BaYlE4HG7kVCdp1Oi5FIx8BAAAAAAACABt3QAAB+wA=',
    minerAddrProof: 'AQDA/3tV3b9wjDI1zQ4htoAYgn+l/daqGpqyzCl/QDbUdg==',
    extraDataProof: 'AYBoy7UwGcq2H2DloO+IEJ+gvcoXl4Lw3IbMc1gL8MPq/w=='
};

/** Onto: Genesis*/
NQ25sampleData.validShare_2 = {
    message: 'share',
    blockHeader: 'AAH6/T8cyAAwnLkxCBJXtOftsPnqQAGHxVD9kUFEfqCGpZEzwRF7tseL/hGulqbi1xtu7ih6/xnc1EUAx+iXQJZRoF++Si5RVTM8WmqTzeN/gptHD+0bM3YceOrIxGprvLZsfaKhCoweRBsyqJEgb7br+BaYlE4HG7kVCdp1Oi5FIx8BAAAAAAACAAAHCAABiFQ=',
    minerAddrProof: 'AQDA/3tV3b9wjDI1zQ4htoAYgn+l/daqGpqyzCl/QDbUdg==',
    extraDataProof: 'AYBoy7UwGcq2H2DloO+IEJ+gvcoXl4Lw3IbMc1gL8MPq/w=='
};

/** Onto: Genesis*/
NQ25sampleData.validShare_3 = {
    message: 'share',
    blockHeader: 'AAH6/T8cyAAwnLkxCBJXtOftsPnqQAGHxVD9kUFEfqCGpZEzwRF7tseL/hGulqbi1xtu7ih6/xnc1EUAx+iXQJZRoF++Si5RVTM8WmqTzeN/gptHD+0bM3YceOrIxGprvLZsfaKhCoweRBsyqJEgb7br+BaYlE4HG7kVCdp1Oi5FIx8BAAAAAAACAAAAAQAAyPI=',
    minerAddrProof: 'AQDA/3tV3b9wjDI1zQ4htoAYgn+l/daqGpqyzCl/QDbUdg==',
    extraDataProof: 'AYBoy7UwGcq2H2DloO+IEJ+gvcoXl4Lw3IbMc1gL8MPq/w=='
};
module.exports = exports = NQ25sampleData;
