import { g, s, db } from "$lib/db";
import { claim, mint } from "$lib/ecash";
import { bail } from "$lib/utils";
import { debit, credit, types } from "$lib/payments";
import { v4 } from "uuid";
import { l, err, warn } from "$lib/logging";
import { emit } from "$lib/sockets";
import store from "$lib/store";

let { ecash: type } = types;

export default {
  async claim({ body: { token }, user }, res) {
    try {
      let amount = await claim(token);

      let memo;
      let hash = v4();
      let { currency, id: uid } = user;
      await s(`invoice:${hash}`, {
        currency,
        id: hash,
        hash,
        rate: store.rates[currency],
        uid,
        received: 0,
      });

      await credit(hash, amount, memo, user.id, type);

      res.send({ ok: true });
    } catch (e) {
      bail(res, e.message);
    }
  },

  async mint({ body: { amount }, user }, res) {
    try {
      let hash = v4();

      let p = await debit({ hash, amount, user, type });
      let token = await mint(amount);
      p.memo = token;
      await s(`payment:${p.id}`, p);

      res.send({ token });
    } catch (e) {
      bail(res, e.message);
    }
  },

  async melt({ body: { amount, bolt11: hash, preimage }, user }, res) {
    try {
      amount = Math.round(amount / 1000);
      let ref = preimage;
      let { lightning: type } = types;
      if (user.username !== "mint") fail("unauthorized");
      let { id: uid, currency, username } = user;
      let ourfee = await db.debit(
        `balance:${uid}`,
        `credit:${type}:${uid}`,
        amount || 0,
        0,
        0,
        0,
      );

      let rate = store.rates[currency];

      if (ourfee.err) fail(ourfee.err);

      let id = v4();
      let p = {
        id,
        amount: -amount,
        hash,
        ourfee,
        uid,
        confirmed: true,
        rate,
        currency,
        type,
        ref,
        created: Date.now(),
      };

      await s(`payment:${hash}`, id);
      await s(`payment:${id}`, p);
      await db.lPush(`${uid}:payments`, id);

      l(user.username, "sent", type, amount);
      emit(user.id, "payment", p);

      res.send(p);
    } catch (e) {
      bail(res, e.message);
    }
  },
};
