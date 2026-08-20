'use strict';

/**
 * What a campaign sells.
 *
 * A campaign rarely sells one thing at one price. Once it sells three, "what a
 * deal is worth" stops being a property of the campaign or of the agent's rank
 * and becomes a property of the thing that was actually sold. So:
 *
 *     the RANK sets the rate.  the PRODUCT sets the value.
 *
 * Nobody types an amount. A product is chosen from a list defined in advance,
 * which keeps the rule this system was built on — that profiles, not people,
 * decide what a deal is worth — while letting one campaign carry a Starter, a
 * Pro and an Enterprise at three different prices.
 *
 * Interest and purchase are kept apart on purpose. What a prospect ticks on a
 * web form is useful to the agent making the call and is never allowed to
 * decide what anybody is paid.
 */

const db = require('./db');
const { basisFor, applyProduct } = require('./commission-math');

/** Products on a campaign, most prominent first. */
function list(campaignId, { includeInactive = false } = {}) {
  return db.all(
    `select * from campaign_products
      where campaign_id = $1 ${includeInactive ? '' : 'and active'}
      order by sort_order, name`,
    [campaignId]
  );
}

/** One product, scoped to its campaign so an id from elsewhere cannot be used. */
function forCampaign(productId, campaignId) {
  if (!productId) return Promise.resolve(null);
  return db.one(
    'select * from campaign_products where id = $1 and campaign_id = $2',
    [productId, campaignId]
  );
}

/** The fields an admin's product form submits. */
function readBody(body, util) {
  return {
    name: util.text(body.name, 120),
    code: util.text(body.code, 40),
    description: util.text(body.description, 300),
    value: Math.max(0, util.num(body.value, 0)),
    sort_order: util.num(body.sort_order, 0),
    active: util.bool(body.active),
  };
}

// basisFor / applyTo are arithmetic and live in commission-math, which stays
// free of the database so the money rules can be tested without one. They are
// re-exported here because this is where callers look for them.
module.exports = { list, forCampaign, basisFor, applyTo: applyProduct, readBody };
