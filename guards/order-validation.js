/**
 * Deterministic order validation — the guard node.
 *
 * This runs in n8n (Code node, "Run Once for All Items") between the ordering
 * specialist and the vendor's order API. Nothing the agent produces reaches the
 * vendor without passing through here.
 *
 * Every block below exists because of a specific production incident. The
 * comments name the incident, because the reason a guard exists is the part
 * that gets lost first.
 *
 * REDACTED FOR PUBLICATION: the vendor's name, the client's menu item names and
 * the real product IDs have been genericized. Credentials were never in the
 * source — the bearer token and base URL arrive as runtime values. The control
 * flow, the checks and the rejection messages are unmodified.
 *
 * Comments translated from the Portuguese originals.
 */

const t = $('When Executed by Another Workflow').item.json;
const entrada = $('Redis').item.json;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lerJson(valor, padrao) {
  if (valor === undefined || valor === null || valor === '') return padrao;
  if (typeof valor === 'object') return valor;
  try { return JSON.parse(valor); } catch (e) { return padrao; }
}

function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Comparison key: letters and digits only. "Coke Zero Can 350 ml" and
// "coke zero can 350ml" collapse to the same string, so the customer's spacing
// and punctuation never break the match.
function chave(s) {
  return normalizar(s).replace(/[^a-z0-9]/g, '');
}

function estaDisponivel(o) {
  if (o.unavailable === true || o.unavailable === 1) return false;
  if (o.unavailableByTemplate === true) return false;
  if (o.available === false || o.available === 0) return false;
  return true;
}

// The vendor only accepts add-ons as an array of OBJECTS {id, qty}. A raw id
// array ([5301381]) returns a generic 500 "Server Error" — a real bug, found
// 2026-08-24, undocumented.
function normalizarExtras(extras) {
  if (!Array.isArray(extras)) return [];
  return extras.map(e => {
    if (typeof e === 'number' || typeof e === 'string') return { id: Number(e), qty: 1 };
    return { id: Number(e.id), qty: Number(e.qty) || 1 };
  }).filter(e => Number.isFinite(e.id) && e.id > 0);
}

/**
 * Rejection with an instruction, not an error code.
 *
 * This is the pattern worth stealing from this file. The agent receives
 * "the customer hasn't answered yet — ask, wait, then call again", which it can
 * act on. Hand an LLM a stack trace and it paraphrases it badly to the customer.
 */
function erro(detalhe) {
  return [{ json: {
    foraDaArea: true,
    itemInvalido: true,
    erroCustom: 'falha_criar_pedido',
    detalheCustom: detalhe
  } }];
}

const endereco = lerJson(t.EnderecoJSON, {});
const payments = lerJson(t.PaymentsJSON, []);

// ---------------------------------------------------------------------------
// GUARD 1 — Delivery type has no default
//
// If the agent omits the field, the code does NOT assume pickup: it refuses.
// The previous default was 'balcony', so a premature tool call silently became
// a counter-pickup order (orderNo 136).
// ---------------------------------------------------------------------------

const deliveryType = String(t.DeliveryType || '').trim().toLowerCase();

if (deliveryType !== 'delivery' && deliveryType !== 'balcony') {
  return erro(`DeliveryType came through as "${t.DeliveryType}" — only "delivery" or "balcony" are valid. Ask the customer whether it is pickup or delivery before calling again.`);
}

// ---------------------------------------------------------------------------
// GUARD 2 — Proof that the question was actually asked
//
// Guard 1 only catches an empty or invalid value. When the agent INVENTS a
// valid one ("balcony") without having asked, it sails through — that is what
// created orderNo 143: the customer answered "everything" about add-ons and the
// order was created as pickup, with delivery never mentioned by anyone.
//
// Five rounds of prompt reinforcement failed to hold this, because it is an LLM
// decision. So the proof moved outside the model: the Master writes
// delivery_asked:{phone} only when the specialist's outgoing message actually
// contains the delivery question (or when the customer stated the type first).
// No key, no order.
// ---------------------------------------------------------------------------

const entregaPerguntada = String((($('Buscar Entrega Perguntada').item || {}).json || {}).entregaPerguntada || '').trim();

if (!entregaPerguntada) {
  return erro('the delivery step was skipped: there is no record that this customer was asked pickup vs. delivery in this conversation. Ask "Are you picking up or is it delivery?", WAIT for their answer, and only then call Criar_pedido again with the complete item list.');
}

// ---------------------------------------------------------------------------
// GUARD 3 — Empty or malformed item payload
//
// lerJson swallows the parse error and returns the default; with an empty list
// no validation fires, orders goes out as [] and the vendor answers
// 400 "Order has no items" — a raw error the agent handles badly.
// ---------------------------------------------------------------------------

const itensBrutos = lerJson(t.ItensPedidoJSON, null);

if (!Array.isArray(itensBrutos) || itensBrutos.length === 0) {
  return erro('ItensPedidoJSON arrived empty or as invalid JSON. Rebuild the array, one object per item, and call Criar_pedido again. Do not split the order across several calls — send every item together in a single call.');
}

// ---------------------------------------------------------------------------
// Fresh menu — the basis for every check below.
//
// The menu is fetched per call rather than cached. An item that sold out two
// minutes ago must fail validation now, not at the vendor.
// ---------------------------------------------------------------------------

const cardapioFresco = await this.helpers.httpRequest({
  method: 'GET',
  url: `${t.VendorBaseUrl}/restaurant/${t.LojaId}/menu`,
  headers: { Authorization: `Bearer ${entrada.token}` },
  json: true
});

const idsGeralValidos = new Set();
(cardapioFresco.general || []).forEach(cat => (cat.products || []).forEach(p => idsGeralValidos.add(Number(p.id))));
const idsComboValidos = new Set((cardapioFresco.combos || []).map(c => Number(c.id)));

// ---------------------------------------------------------------------------
// Add-on group map.
//
// Each combo carries its OWN add-on group, with option ids different from the
// standalone burger's group. Sending the standalone id on a combo returns
// 400 "Extra does not belong to combo". This map makes the check deterministic
// instead of hoping the model tracks it.
// ---------------------------------------------------------------------------

const opcoesPorGrupo = {};
(cardapioFresco.extras || []).forEach(g => {
  opcoesPorGrupo[Number(g.id)] = new Set((g.options || []).map(o => Number(o.id)));
});

const extrasValidosPorItem = {};
function registrarExtras(prefixo, item) {
  const validos = new Set();
  (item.extras || []).forEach(gid => {
    (opcoesPorGrupo[Number(gid)] || new Set()).forEach(oid => validos.add(oid));
  });
  extrasValidosPorItem[prefixo + Number(item.id)] = validos;
}
(cardapioFresco.general || []).forEach(cat => (cat.products || []).forEach(p => registrarExtras('g', p)));
(cardapioFresco.combos || []).forEach(c => registrarExtras('c', c));

// Canned drinks AVAILABLE right now.
const bebidasLataDisponiveis = [];
(cardapioFresco.general || []).forEach(cat => {
  if (!normalizar(cat.name).includes('bebida')) return;
  (cat.products || []).forEach(p => {
    if (!normalizar(p.name).includes('lata')) return;
    if (!estaDisponivel(p)) return;
    bebidasLataDisponiveis.push(p.name);
  });
});

// Item ids from every order already closed in this conversation
// (written by "Salvar Itens Pedido", TTL 2h).
let idsJaPedidos = [];
try {
  const raw = (($('Buscar Itens Pedido Anterior').item || {}).json || {}).itensAnteriores;
  idsJaPedidos = raw ? JSON.parse(raw) : [];
} catch (e) { idsJaPedidos = []; }

// ---------------------------------------------------------------------------
// GUARD 4 — Invalid item id
//
// This is the one from the case study. The vendor's payload exposes an
// undocumented internal field sharing the exact numeric shape of real product
// ids, and the model picked it up as if it were a product. Checking against the
// live menu is the only thing that catches it — the id LOOKS correct.
// ---------------------------------------------------------------------------

const itemInvalido = itensBrutos.find(o => {
  const id = Number(o.id);
  return o.type === 'combo' ? !idsComboValidos.has(id) : !idsGeralValidos.has(id);
});

// GUARD 5 — id/type vs. notes consistency.
// The "Bebida:" note only exists in the combo flow. If it shows up on an item
// that is not type "combo", the combo was swapped for the standalone during
// assembly.
const itemInconsistente = !itemInvalido && itensBrutos.find(o =>
  o.type !== 'combo' && /bebida\s*:/i.test(String(o.notes || ''))
);

// GUARD 6 — add-on from another group.
const itemExtraInvalido = !itemInvalido && !itemInconsistente && itensBrutos.find(o => {
  const extras = normalizarExtras(o.extras);
  if (extras.length === 0) return false;
  const validos = extrasValidosPorItem[(o.type === 'combo' ? 'c' : 'g') + Number(o.id)];
  if (!validos || validos.size === 0) return true;
  return extras.some(e => !validos.has(e.id));
});

// GUARD 7 — the combo's drink must match exactly ONE available can.
// Equality or prefix match on the alphanumeric key, and the match must be
// unique. Ambiguity is rejected, not guessed.
const itemBebidaInvalida = !itemInvalido && !itemInconsistente && !itemExtraInvalido && itensBrutos.find(o => {
  const m = /bebida\s*:\s*(.+)/i.exec(String(o.notes || ''));
  if (!m) return false;
  const pedida = chave(m[1]);
  if (pedida.length < 4) return true;
  const candidatos = bebidasLataDisponiveis.filter(nome => {
    const b = chave(nome);
    return b === pedida || b.startsWith(pedida) || pedida.startsWith(b);
  });
  return candidatos.length !== 1;
});

// GUARD 8 — combo with no drink note at all.
const itemSemBebida = !itemInvalido && !itemInconsistente && !itemExtraInvalido && !itemBebidaInvalida && itensBrutos.find(o =>
  o.type === 'combo' && !/bebida\s*:\s*.+/i.test(String(o.notes || ''))
);

// GUARD 9 — item already charged in this conversation.
// "Salvar Itens Pedido" used to store only the current order's ids, overwriting
// the previous ones — so with two Criar_pedido calls in one turn, the second
// read an already-overwritten key and let a charged item through (orderNo 136
// and 138 both charged the same combo). The accumulated list is now computed
// here and the Redis node only writes the result.
const itemJaPedidoAnterior = !itemInvalido && !itemInconsistente && !itemExtraInvalido && !itemBebidaInvalida && !itemSemBebida &&
  itensBrutos.find(o => idsJaPedidos.includes(Number(o.id)));

if (itemInvalido || itemInconsistente || itemExtraInvalido || itemBebidaInvalida || itemSemBebida || itemJaPedidoAnterior) {
  const alvo = itemInvalido || itemInconsistente || itemExtraInvalido || itemBebidaInvalida || itemSemBebida || itemJaPedidoAnterior;
  let detalhe;

  if (itemInvalido) {
    detalhe = `invalid item: id ${alvo.id} (type ${alvo.type}) does not exist in the current menu`;
  } else if (itemInconsistente) {
    detalhe = `inconsistent item: id ${alvo.id} carries a combo drink note but was sent as type "${alvo.type}" (should be "combo")`;
  } else if (itemExtraInvalido) {
    const validos = extrasValidosPorItem[(alvo.type === 'combo' ? 'c' : 'g') + Number(alvo.id)];
    detalhe = `invalid add-on on item id ${alvo.id} (type ${alvo.type}). Each combo has its own add-on group, with ids different from the standalone burger's. Accepted ids for this item: ${validos && validos.size ? Array.from(validos).join(', ') : '(this item takes no add-ons)'}. Check the menu, use the group listed in THIS item's "extras" field and call Criar_pedido again.`;
  } else if (itemSemBebida) {
    detalhe = `combo id ${alvo.id} was sent without the notes field carrying the drink. If the customer ALREADY chose a drink in this conversation, do NOT ask again: take the name they said, write it in notes as "Bebida: NAME" and call Criar_pedido again. Only ask if they genuinely never chose.`;
  } else if (itemJaPedidoAnterior) {
    detalhe = `item id ${alvo.id} was already part of an earlier order in this same conversation (already charged) — drop it and call Criar_pedido again with only the new items`;
  } else {
    detalhe = `the drink on combo id ${alvo.id} did not match exactly one menu option — the note says "${alvo.notes}", and the cans available right now are: ${bebidasLataDisponiveis.join(', ') || '(none)'}. Use the exact name of one of them.`;
  }

  return erro(detalhe);
}

// ---------------------------------------------------------------------------
// GUARD 10 — the vendor recalculates the total; the totals we send are ignored.
//
// The real delivery fee comes from the address, not from a zone the model
// guessed (confirmed with vendor support 2026-08-17:
// POST /restaurant/{id}/deliveryfees). found=false means the store does not
// deliver there — that is an answer, not an error.
// ---------------------------------------------------------------------------

if (deliveryType === 'delivery') {
  user.address     = String(endereco.address || '');
  user.number      = String(endereco.streetNumber || endereco.number || '');
  user.zone        = String(endereco.neighborhood || endereco.zone || '');
  user.city        = String(endereco.city || '');
  user.complemento = String(endereco.complement || endereco.complemento || '');
  user.address_ref = String(endereco.address_ref || endereco.referencePoint || '');

  const taxa = await this.helpers.httpRequest({
    method: 'POST',
    url: `${t.VendorBaseUrl}/restaurant/${t.LojaId}/deliveryfees`,
    headers: {
      Authorization: `Bearer ${entrada.token}`,
      'Content-Type': 'application/json'
    },
    body: {
      street: user.address,
      number: user.number,
      zone: user.zone,
      city: user.city
    },
    json: true
  });

  if (!taxa || taxa.found !== true) {
    return [{ json: { foraDaArea: true } }];
  }

  const taxaReal = Number(taxa.deliveryFee) || 0;
  // The client's own pricing rule is applied here (redacted for publication).
  // The point that generalizes: the fee is whatever the vendor resolved from the
  // address, never a value the model produced or a zone it guessed.
  const taxaCobrada = applyClientPricingRule(taxaReal);

  details.deliveryFeeID = taxa.deliveryFeeID;
  details.deliveryFee = taxaReal;

  totalFinal = totalItens + taxaCobrada;
  paymentsFinal = paymentsFinal.map((p, i) =>
    i === 0 ? { ...p, value: Number(p.value || 0) + taxaCobrada } : p
  );
}

details.total = totalFinal;
details.payments = paymentsFinal;

const idsAcumulados = Array.from(new Set(
  idsJaPedidos.map(Number).concat(itensBrutos.map(o => Number(o.id)))
)).filter(n => Number.isFinite(n) && n > 0);

const body = { user, orders, details };
return [{ json: { ...entrada, body, foraDaArea: false, idsAcumulados } }];
