import config from "$config";
import store from "$lib/store";
import { emit } from "$lib/sockets";
import { v4 } from "uuid";
import { db, g, s, t } from "$lib/db";
import { l, err } from "$lib/logging";
import { fail, btc, sats } from "$lib/utils";
import { requirePin } from "$lib/auth";
import { debit, credit, confirm, types } from "$lib/payments";
import { bech32 } from "bech32";
import { invoice } from "$lib/invoices";
import got from "got";

import bc from "$lib/bitcoin";
import ln from "$lib/ln";

export default {
  async create({ body, user }, res) {
    let { amount, hash, maxfee, name, memo, payreq, tip } = body;

    amount = parseInt(amount);
    maxfee = parseInt(maxfee);
    tip = parseInt(tip);

    await requirePin({ body, user });

    let p;

    if (payreq) {
      p = await debit(
        hash,
        amount + maxfee,
        maxfee,
        memo,
        user,
        types.lightning
      );

      let r = await ln.pay(payreq);

      p.amount = -amount;
      p.hash = r.payment_hash;
      p.fee = r.msatoshi_sent - r.msatoshi;
      p.ref = r.payment_preimage;

      await s(`payment:${p.id}`, p);
      await db.incrBy(`balance:${p.uid}`, maxfee - p.fee);
    } else if (hash) {
      p = await debit(hash, amount, 0, memo, user);
      await credit(hash, amount, memo, user.id);
    } else {
      let pot = name || v4();
      p = await debit(hash, amount, 0, memo, user);
      await db.incrBy(`pot:${pot}`, amount);
      await db.lPush(`pot:${pot}:payments`, p.id);
      l("funded pot", pot);
    }

    res.send(p);
  },

  async list({ user: { id }, query: { start, end, limit, offset } }, res) {
    if (limit) limit = parseInt(limit);
    if (offset) offset = parseInt(offset);

    // if (start || end) where.createdAt = {};
    // if (start) where.createdAt[Op.gte] = new Date(parseInt(start));
    // if (end) where.createdAt[Op.lte] = new Date(parseInt(end));

    let payments = (await db.lRange(`${id}:payments`, 0, -1)) || [];
    payments = await Promise.all(
      payments.map(async id => {
        let p = await g(`payment:${id}`);
        if (p.type === types.internal) p.with = await g(`user:${p.ref}`);
        return p;
      })
    );
    res.send({ payments, total: payments.length });
  },

  async get({ params: { hash } }, res) {
    res.send(await g(`payment:${hash}`));
  },

  async parse({ body: { payreq } }, res) {
    let hour = 1000 * 60 * 60;
    let { last } = store.nodes;
    let { nodes } = store;

    if (!last || last > Date.now() - hour) ({ nodes } = await ln.listnodes());
    store.nodes = nodes;

    let twoWeeksAgo = new Date(new Date().setDate(new Date().getDate() - 14));
    let decoded = await ln.decodepay(payreq);
    let { msatoshi, payee } = decoded;
    let node = nodes.find(n => n.nodeid === payee);
    let alias = node ? node.alias : payee.substr(0, 12);

    res.send({ alias, amount: Math.round(msatoshi / 1000) });
  },

  async pot({ params: { name } }, res) {
    let amount = await g(`pot:${name}`);
    let payments = (await db.lRange(`pot:${name}:payments`, 0, -1)) || [];
    payments = await Promise.all(payments.map(hash => g(`payment:${hash}`)));

    await Promise.all(
      payments.map(async p => (p.user = await g(`user:${p.uid}`)))
    );

    payments = payments.filter(p => p);
    res.send({ amount, payments });
  },

  async take({ body: { name, amount }, user }, res) {
    amount = parseInt(amount);
    await t(`pot:${name}`, async balance => {
      if (balance < amount) fail("Insufficient funds");
      return balance - amount;
    });

    let hash = v4();
    await s(`invoice:${hash}`, {
      uid: user.id,
      received: 0
    });

    let payment = await credit(hash, amount, "", name, types.pot);
    await db.lPush(`${name}:payments`, hash);

    res.send({ payment });
  },

  async bitcoin({ body: { txid, wallet } }, res) {
    if (wallet === config.bitcoin.wallet) {
      let { confirmations, details } = await bc.getTransaction(txid);
      for (let { address, amount, vout } of details) {
        if (confirmations > 0) {
          await confirm(address, txid, vout);
        } else {
          await credit(
            address,
            sats(amount),
            "",
            `${txid}:${vout}`,
            types.bitcoin
          );
        }
      }
    }
    res.send({});
  },

  async fee(req, res) {
    let { amount, address, feeRate, subtract } = req.body;
    let subtractFeeFromOutputs = subtract ? [0] : [];
    let replaceable = true;
    let outs = [{ [address]: btc(amount) }];
    let count = await bc.getBlockCount();

    let raw = await bc.createRawTransaction([], outs, 0, replaceable);
    let tx = await bc.fundRawTransaction(raw, {
      feeRate,
      subtractFeeFromOutputs,
      replaceable
    });

    if (config.bitcoin.walletpass)
      await bc.walletPassphrase(config.bitcoin.walletpass, 300);

    let { hex } = await bc.signRawTransactionWithWallet(tx.hex);
    let { vsize } = await bc.decodeRawTransaction(hex);
    feeRate = Math.round((sats(tx.fee) * 1000) / vsize);

    res.send({ feeRate, tx });
  },

  async send(req, res) {
    await requirePin(req);

    let { user } = req;
    let { address, memo, tx } = req.body;
    let { hex, fee } = tx;

    if (config.bitcoin.walletpass)
      await bc.walletPassphrase(config.bitcoin.walletpass, 300);

    ({ hex } = await bc.signRawTransactionWithWallet(hex));

    let r = await bc.testMempoolAccept([hex]);
    if (!r[0].allowed) fail("transaction rejected");

    fee = sats(fee);
    if (fee < 0) fail("fee cannot be negative");

    tx = await bc.decodeRawTransaction(hex);
    let { txid } = tx;

    let total = 0;
    let change = 0;

    for (let {
      scriptPubKey: { address },
      value
    } of tx.vout) {
      total += sats(value);
      if (
        (await bc.getAddressInfo(address)).ismine &&
        !(await g(`invoice:${address}`))
      )
        change += sats(value);
    }

    total = total - change + fee;
    let amount = total - fee;

    await debit(txid, amount, fee, null, user, types.bitcoin, txid);
    await bc.sendRawTransaction(hex);

    res.send({ txid });
  },

  async encode({ query: { address } }, res) {
    let [name, domain] = address.split("@");
    let url = `https://${domain}/.well-known/lnurlp/${name}`;
    let r = await got(url).json();
    if (r.tag !== "payRequest") fail("not an ln address");
    let enc = bech32.encode("lnurl", bech32.toWords(Buffer.from(url)), 20000);
    res.send(enc);
  },

  async decode({ query: { text } }, res) {
    let url = Buffer.from(
      bech32.fromWords(bech32.decode(text, 20000).words)
    ).toString();

    res.send(await got(url).json());
  },

  async lnurlp({ params: { username } }, res) {
    let uid = await g(`user:${username}`);
    if (!uid) fail("user not found");

    let id = v4();
    await s(`lnurl:${id}`, uid);
    let { URL } = process.env;
    let host = URL.split("/").at(-1);

    res.send({
      metadata: [
        ["text/plain", `Paying ${username}@${host}`],
        ["text/identifier", `${username}@${host}`]
      ],
      callback: `${host}/lnurl/${id}`,
      tag: "payRequest"
    });
  },

  async lnurl({ params: { id }, query: { amount } }, res) {
    let pr = await g(`lnurlp:${id}`);

    if (!pr) {
      let uid = await g(`lnurl:${id}`);
      let user = await g(`user:${uid}`);

      ({ text: pr } = await invoice({
        invoice: {
          amount,
          type: types.lightning
        },
        user
      }));

      await s(`lnurlp:${id}`, pr);
    }

    res.send({ pr });
  }
};
