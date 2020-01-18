const Web3 = require("web3");
const Tx = require('ethereumjs-tx').Transaction;
const vestingAbi = require('./abi/Vesting.json');
const { createSendTx, getCommitedTx } = require('./send')

const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const config = require('./config');
const keys = require('./keys.json');
const DENOM = "eul"

// cyber18q5s5rt93sdpe9tzyu6qz66slx2yv6wdfzxlqq

// for debug, to delete
function genRandString(length) {
  var result           = '';
  var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for ( var i = 0; i < length; i++ ) {
     result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

const resultWriter = createCsvWriter({
    path: './results.csv',
    append: true,
    header: [
      {id: 'historyId', title: 'HistoryID'},
      {id: 'ethereumFrom', title: 'EthereumFrom'},
      {id: 'personalId', title: 'PersonalID'},
      {id: 'amount', title: 'Amount'},
      {id: 'cyberTo', title: 'CyberTo'},
      {id: 'cyberSendTx', title: 'CyberSendTx'},
      {id: 'ethereumProofTx', title: 'EthereumProofTx'},
      {id: 'timestamp', title: 'Timestamp'}
    ]
});

let ethereumPrivateKey = new Buffer.from(keys.ethereumPrivateKey, 'hex');
let wsProvider, wsWeb3, contract, ethereumAccount;
let contractAddress = config.ethereumContract;

function initWeb3() {
    wsProvider = new Web3.providers.WebsocketProvider(config.ethereumWsServer);
    wsWeb3 = new Web3(wsProvider);
    ethereumAccount = wsWeb3.eth.accounts.privateKeyToAccount("0x"+keys.ethereumPrivateKey);

    let calledOnce = false; 
    wsProvider.on('error', onWsError);
    wsProvider.on('end', onWsError);

    initCompanion();

    function onWsError(e) {
        if (calledOnce) {
            return;
        }
        calledOnce = true;
        console.warn("[" + Math.floor(new Date() / 1000), + "] " + "Websocket reconnect...");
        setTimeout(() => {
            initWeb3();
        }, 3000);
    }
}

initWeb3();

async function initCompanion() {
    console.log("\n🚀 Automatic sender launched!");
    contract = new wsWeb3.eth.Contract(vestingAbi, contractAddress);
    contract.events.NewLock({}, sendTokensAndProof)
    .on("connected", (subscriptionId) => {
        console.log("[" + Math.floor(new Date() / 1000) + "] " + "Connected, subscriptionId: ", subscriptionId);
    })
};

async function sendTokensAndProof(error, event) {
    let debug = false;
    try {
      if (debug == true) {
        const ethereumProofTx = await sendProof(event.returnValues.vestingId, event.returnValues.claimer, genRandString(64).toUpperCase());
        
        await addResultsLog(
          event.returnValues.historyId,
          event.returnValues.claimer,
          event.returnValues.vestingId,
          event.returnValues.amount,
          event.returnValues.account,
          "debugTx",
          ethereumProofTx,
        );
      } else {
        const memo = `Claim #${event.returnValues.vestingId} of ${event.returnValues.claimer}. History ID#${event.returnValues.historyId}. Tx ${event.transactionHash}`
        const checkedTx = await createSendTx(event.returnValues.account, event.returnValues.amount, DENOM, memo)
        if (checkedTx.code && checkedTx.code != 0) {
            throw new Error("Cyber's Tx failed");
        }

        const deliveredTx = await getCommitedTx(checkedTx.txhash);
        if (deliveredTx.code && deliveredTx.code != 0) {
          throw new Error("Cyber's Tx failed");
        }

        const ethereumProofTx = await sendProof(event.returnValues.vestingId, event.returnValues.claimer, deliveredTx.txhash);
        
        await addResultsLog(
            event.returnValues.historyId,
            event.returnValues.claimer,
            event.returnValues.vestingId,
            event.returnValues.amount,
            event.returnValues.account,
            deliveredTx.txhash,
            ethereumProofTx,
        );
      }
    } catch (error) {
        console.log(error);
        await addResultsLog(
          event.returnValues.historyId,
          event.returnValues.claimer,
          event.returnValues.vestingId,
          event.returnValues.amount,
          event.returnValues.account,
      );
    }
}

async function sendProof(id, claimer, proof) {
    const dataProof = contract.methods.addProof(claimer, id, proof).encodeABI();

    const nonce = await wsWeb3.eth.getTransactionCount(ethereumAccount.address, "pending");
    const rawTx = {
        nonce: wsWeb3.utils.numberToHex(nonce),
        gasPrice: wsWeb3.utils.numberToHex(wsWeb3.utils.toWei(config.ethereumGasPriceGwei, 'Gwei')),
        gasLimit: wsWeb3.utils.numberToHex(200000),
        to: contractAddress,
        data: dataProof
    };
    
    let tx = new Tx(rawTx, {'chain':'rinkeby'});

    tx.sign(ethereumPrivateKey);
    const serializedTx = tx.serialize();

    let response;
    await wsWeb3.eth.sendSignedTransaction('0x' + serializedTx.toString('hex'))
    .on('receipt', (receipt) => {
      response = receipt.transactionHash
    })
    .on('error', (error, receipt) => {
      response = "sendProofError";
    })
    return response;
}

async function addResultsLog(
  historyId, 
  ethereumFrom, 
  personalId, 
  amount, 
  cyberTo, 
  cyberSendTx = "sendTokensError", 
  ethereumProofTx = "sendProofError"
) {
  await resultWriter.writeRecords([{
      historyId: historyId,
      ethereumFrom: ethereumFrom,
      personalId: personalId,
      amount: amount,
      cyberTo: cyberTo,
      cyberSendTx: cyberSendTx,
      ethereumProofTx: ethereumProofTx,
      timestamp: Math.floor(new Date() / 1000)
  }]);
}