const Secp256k1 = require('secp256k1');
const bech32 = require('bech32')
const Sha256 = require('sha256');
const RIPEMD160 = require('ripemd160');
const sleep = require('util').promisify(setTimeout)
const axios = require('axios')

const config = require('./config');
const keys = require('./keys.json');

async function createSendTx(subjectTo, amount, denom, memo) {
    const txContext = await createTxContext(memo)
  
    const tx = await createSend(
      txContext,
      subjectTo,
      amount,
      denom,
      memo
    );
    
    const signedTx = await sign(tx, txContext);
    return txSubmit(signedTx)
};

async function createTxContext(memo) {
    const pubKey = getPubKey()
    const account = getAccount(pubKey)
    const accountInfo = await getAccountInfo(account)
  
    const txContext = {
      accountNumber: accountInfo.account_number,
      chainId: accountInfo.chainId,
      sequence: accountInfo.sequence,
      bech32: account,
      memo: memo,
      pk: pubKey.toString('hex'),
    };
    
    return txContext
};

//----------------------------------------------------------

function getPubKey () {
    const PRIV_KEY = keys.cyberPrivateKey;
    const prikeyArr = new Uint8Array(hexToBytes(PRIV_KEY));
    return bytesToHex(Secp256k1.publicKeyCreate(prikeyArr, true))
};

function getAccount (pubkey) {
    const address = getAddress(hexToBytes(pubkey))
    return toBech32("cyber", address)
};

function getAddress(pubkey) {
    if (pubkey.length > 33) {
      pubkey = pubkey.slice(5, pubkey.length);
    }
    const hmac = Sha256(pubkey);
    const b = Buffer.from(hexToBytes(hmac));
    const addr = new RIPEMD160().update(b);
  
    return addr.digest('hex').toUpperCase();
};

//----------------------------------------------------------

function hexToBytes(hex) {
    const bytes = [];
    for (let c = 0; c < hex.length; c += 2) {
        bytes.push(parseInt(hex.substr(c, 2), 16));
    }
    return bytes;
  }
  
  function toBech32(prefix, str) {
    const strByte = bech32.toWords(Buffer.from(str, 'hex'));
  
    return bech32.encode(prefix, strByte);
  }
  
  function bytesToHex(bytes) {
    const hex = [];
  
    for (let i = 0; i < bytes.length; i++) {
        hex.push((bytes[i] >>> 4).toString(16));
        hex.push((bytes[i] & 0xF).toString(16));
    }
    return hex.join('').toUpperCase();
  }
  
  //----------------------------------------------------------

async function getAccountInfo(address) {
    try {
      const result = await axios({
        method: 'get',
        url: `${config.cyberRpcServer}/api/account?address="${address}"`
      });  
      
      const accountInfo = result.data;
      if(!accountInfo.result) { throw error };
  
      let account = accountInfo.result.account;
      if(!account) { throw error };
  
      account.chainId = config.cyberChainId;
  
      return account
    } catch (error) {
        console.error(error);
    }
};

//----------------------------------------------------------

function createSend(txContext, recipient, amount, denom, memo) {
    const txSkeleton = createSkeleton(txContext, denom, memo);
  
    const txMsg = {
      type: 'cosmos-sdk/MsgSend',
      value: {
        amount: [
          {
            amount: amount.toString(),
            denom: denom,
          },
        ],
        from_address: txContext.bech32,
        to_address: recipient,
      },
    };
  
    txSkeleton.value.msg = [txMsg];
  
    return txSkeleton;
};

function createSkeleton (txContext, denom, memo) {
    if (typeof txContext === 'undefined') {
      throw new Error('undefined txContext');
    }
    if (typeof txContext.accountNumber === 'undefined') {
      throw new Error('txContext does not contain the accountNumber');
    }
    if (typeof txContext.sequence === 'undefined') {
      throw new Error('txContext does not contain the sequence value');
    }
    const txSkeleton = {
      type: 'auth/StdTx',
      value: {
        msg: [], // messages
        fee: '',
        memo: memo,
        signatures: [
          {
            signature: 'N/A',
            account_number: txContext.accountNumber.toString(),
            sequence: txContext.sequence.toString(),
            pub_key: {
              type: 'tendermint/PubKeySecp256k1',
              value: 'PK',
            },
          },
        ],
      },
    };
    return applyGas(txSkeleton, 0, denom);
};


function applyGas(unsignedTx, gas, denom) {
    if (typeof unsignedTx === 'undefined') {
      throw new Error('undefined unsignedTx');
    }
    if (typeof gas === 'undefined') {
      throw new Error('undefined gas');
    }
  
    unsignedTx.value.fee = {
      amount: [
        {
          amount: '0', // TODO apply fee for cosmos support
          denom: denom,
        },
      ],
      gas: gas.toString(),
    };
  
    return unsignedTx;
};

//----------------------------------------------------------

async function sign(unsignedTx, txContext) {
    const bytesToSign = getBytesToSign(unsignedTx, txContext);
    const PRIV_KEY = keys.cyberPrivateKey;
    
    const hash = new Uint8Array(Sha256(Buffer.from(bytesToSign), {
      asBytes: true 
    }));
    const prikeyArr = new Uint8Array(hexToBytes(PRIV_KEY));
    const sig = Secp256k1.ecdsaSign(hash, prikeyArr);
  
    return applySignature(unsignedTx, txContext, Array.from(sig.signature));
};

function getBytesToSign(tx, txContext) {
  if (typeof txContext === 'undefined') {
    throw new Error('txContext is not defined');
  }
  if (typeof txContext.chainId === 'undefined') {
    throw new Error('txContext does not contain the chainId');
  }
  if (typeof txContext.accountNumber === 'undefined') {
    throw new Error('txContext does not contain the accountNumber');
  }
  if (typeof txContext.sequence === 'undefined') {
    throw new Error('txContext does not contain the sequence value');
  }

  const txFieldsToSign = {
    account_number: txContext.accountNumber.toString(),
    chain_id: txContext.chainId,
    fee: tx.value.fee,
    memo: tx.value.memo,
    msgs: tx.value.msg,
    sequence: txContext.sequence.toString(),
  };

  return JSON.stringify(removeEmptyProperties(txFieldsToSign));
};

function removeEmptyProperties (jsonTx) {
  if (Array.isArray(jsonTx)) {
    return jsonTx.map(removeEmptyProperties)
  }

  if (typeof jsonTx !== `object`) {
    return jsonTx
  }

  const sorted = {}
  Object.keys(jsonTx)
    .sort()
    .forEach(key => {
      if (jsonTx[key] === undefined || jsonTx[key] === null) return
      sorted[key] = removeEmptyProperties(jsonTx[key])
    })
  return sorted
};

function applySignature(unsignedTx, txContext, secp256k1Sig) {
    if (typeof unsignedTx === 'undefined') {
      throw new Error('undefined unsignedTx');
    }
    if (typeof txContext === 'undefined') {
      throw new Error('undefined txContext');
    }
    if (typeof txContext.pk === 'undefined') {
      throw new Error('txContext does not contain the public key (pk)');
    }
    if (typeof txContext.accountNumber === 'undefined') {
      throw new Error('txContext does not contain the accountNumber');
    }
    if (typeof txContext.sequence === 'undefined') {
      throw new Error('txContext does not contain the sequence value');
    }
  
    const tmpCopy = Object.assign({}, unsignedTx, {});
  
    tmpCopy.value.signatures = [
      {
        signature: Buffer.from(secp256k1Sig).toString('base64'),
        account_number: txContext.accountNumber.toString(),
        sequence: txContext.sequence.toString(),
        pub_key: {
          type: 'tendermint/PubKeySecp256k1',
          value: Buffer.from(hexToBytes(txContext.pk)).toString('base64'),
        },
      },
    ];
    return tmpCopy;
};

//----------------------------------------------------------

async function txSubmit(signedTx) {
    const txBody = {
      tx: signedTx.value,
      mode: 'sync',
    };
    const result = await axios({
      method: 'post',
      headers: {
          'Content-Type': 'application/json',
      },
      url: `${config.cyberRpcServer}/lcd/txs`,
      data: JSON.stringify(txBody),
    })
    if (result.data.error) throw res.data.error;
    return result.data
};

async function getCommitedTx(txHash) {
    await sleep(3*7000);
    return await axios({
      method: 'get',
      url: `${config.cyberRpcServer}/lcd/txs/${txHash}`,
    })
    .then(res => {
      if (res.data.error) throw res.data.error;
      return res.data;
    })
    .catch(error => {
      console.error('Transfer not commited:\n', error);
      throw error;
    });
}

//----------------------------------------------------------

module.exports = {
    createSendTx,
    getCommitedTx
}

