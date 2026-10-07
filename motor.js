// motor.js — motor de distribución de pedidos (puro, sin dependencias).
// Todo lo que antes estaba fijo en el código (chóferes, rutas, reglas) llega en `cfg`.

export const JORNADA_HORAS = 8;
export const MMA_DEFAULT = 26000;
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

export const cargaUtil = (d) => Math.max(0, (d.mma ?? MMA_DEFAULT) - d.tara);
const suma = (l) => l.reduce((a, p) => a + (p.kgs || 0), 0);
const diaSemana = (iso) => new Date(iso + "T00:00:00Z").getUTCDay(); // sin depender de la zona horaria

export function normalizarRuta(codigo) {
  const raw = String(codigo ?? "").trim().toUpperCase();
  if (!raw) return "";
  if (raw.includes("SUS") && raw.includes("MEDIOS")) return "SUS MEDIOS";
  const c = raw.replace(/\s+/g, "").replace(/^RUTA/, "R").replace(/^R-?/, "R");
  const n = c.match(/^\d{1,2}$/) || c.match(/^R0?(\d{1,2})$/);
  return n ? `R${(n[1] ?? n[0]).padStart(2, "0")}` : c;
}

const limpiar = (p, extra) =>
  Object.assign(p, { asignadoA: undefined, asignadoNombre: undefined, proveedor: undefined,
    motivoSinAsignar: undefined, alerta: undefined }, extra);
const lgm = (p, obs) => limpiar(p, { status: "subcontratado", proveedor: "LGM", asignadoNombre: "LGM", observaciones: obs });
const pendiente = (p, motivo, obs, alerta) => limpiar(p, { status: "sin_asignar", motivoSinAsignar: motivo, observaciones: obs, alerta });
const asignar = (p, d, obs) => limpiar(p, { status: "interno", asignadoA: d.id, asignadoNombre: d.nombre, observaciones: obs ?? p.observaciones });

function repartirPorCliente(lista, choferes) {
  const grupos = choferes.map((d) => ({ d, lista: [], kg: 0 }));
  const sinRepartir = [];
  const porCliente = new Map();
  lista.forEach((p) => {
    const k = (p.cliente || "").trim().toUpperCase() || `__${p.id}`;
    porCliente.set(k, [...(porCliente.get(k) ?? []), p]);
  });
  [...porCliente.values()].map((l) => ({ l, kg: suma(l) })).sort((a, b) => b.kg - a.kg).forEach(({ l, kg }) => {
    const g = grupos.filter((g) => g.kg + kg <= cargaUtil(g.d)).sort((a, b) => a.kg - b.kg)[0];
    if (!g) return void sinRepartir.push(...l);
    g.lista.push(...l);
    g.kg += kg;
  });
  return { grupos: grupos.filter((g) => g.lista.length), sinRepartir };
}

/** Devuelve copias de los pedidos con la asignación calculada. Los pedidos con `manual: true` no se tocan. */
export function aplicarReglas(pedidos, cfg, fechaPlan) {
  const { drivers, rutas, horasOverride = {}, semana = {}, reglas = {} } = cfg;
  const info = (c) => rutas.find((r) => r.codigo === c);
  const horasDe = (c) => Math.min(horasOverride[c] ?? info(c)?.horas ?? 0, JORNADA_HORAS);
  const activos = drivers.filter((d) => d.activo !== false && d.tipo === "INTERNO");
  const fijos = activos.filter((d) => d.rol === "fijo");
  const reparto = activos.filter((d) => d.rol !== "fijo");
  const permitidas = (d) => new Set((d.rutasPermitidas ?? []).map(normalizarRuta));

  // 1) Reglas individuales
  const out = pedidos.map((o) => {
    const p = { ...o, ruta: normalizarRuta(o.ruta) };
    if (p.manual) return p;
    p.zona = info(p.ruta)?.zona ?? o.ruta ?? "—";
    if (reglas.clienteLGM && (p.cliente || "").toUpperCase().includes(reglas.clienteLGM))
      return lgm(p, `Cliente ${reglas.clienteLGM} — siempre LGM`);
    const tipo = info(p.ruta)?.tipo;
    if (tipo === "recoge") return limpiar(p, { status: "recoge", asignadoNombre: "Cliente recoge", observaciones: "Cliente recoge en plataforma" });
    if (tipo === "export") return limpiar(p, { status: "export", asignadoNombre: "Export — cliente gestiona", observaciones: "Embalado pendiente de recogida (cliente gestiona transporte)" });
    return limpiar(p, { status: "sin_asignar" });
  });

  // 2) Rutas fijas por día de la semana (las de recoge/interna/export están exentas)
  const dow = diaSemana(fechaPlan);
  const prog = (semana[dow] ?? []).map(normalizarRuta);
  const exenta = (r) => ["recoge", "interna", "export"].includes(info(r)?.tipo);
  const pend = out.filter((p) => p.status === "sin_asignar" && !p.manual);
  const bloqueadas = new Set(prog.length ? pend.filter((p) => !exenta(p.ruta) && !prog.includes(p.ruta)).map((p) => p.ruta) : []);
  pend.filter((p) => bloqueadas.has(p.ruta)).forEach((p) =>
    pendiente(p, `Ruta ${p.ruta} no programada para ${DIAS[dow]}`, `Aplazar: ${p.ruta} no es día fijo (${DIAS[dow]})`, "Ruta no programada este día"));

  const porRuta = new Map();
  pend.filter((p) => !bloqueadas.has(p.ruta)).forEach((p) => porRuta.set(p.ruta, [...(porRuta.get(p.ruta) ?? []), p]));

  // 3) Capacidad usada, reservando lo ya fijado a mano
  const uso = new Map(activos.map((d) => [d.id, { kg: 0, h: 0, rutas: new Set() }]));
  out.filter((p) => p.manual && p.status === "interno" && uso.has(p.asignadoA)).forEach((p) => {
    const u = uso.get(p.asignadoA);
    u.kg += p.kgs || 0;
    if (!u.rutas.has(p.ruta)) { u.rutas.add(p.ruta); u.h += horasDe(p.ruta); }
  });
  const orden = (a, b) => {
    const x = uso.get(a.id), y = uso.get(b.id);
    return x.rutas.size - y.rutas.size || x.h - y.h || x.kg - y.kg || (a.prioridad ?? 99) - (b.prioridad ?? 99);
  };

  // 4) Bloques por ruta: obligatorias y entrega más próxima primero
  const bloques = [...porRuta].map(([ruta, lista]) => {
    const minF = lista.map((p) => p.fechaEntrega).filter(Boolean).sort()[0] ?? "9999-12-31";
    return { ruta, lista, h: horasDe(ruta), kg: suma(lista), minF, oblig: lista.some((p) => p.urgente) || minF <= fechaPlan };
  }).sort((a, b) => (b.oblig - a.oblig) || (a.minF < b.minF ? -1 : a.minF > b.minF ? 1 : 0) || b.h - a.h);

  for (const b of bloques) {
    const interna = info(b.ruta)?.tipo === "interna";
    const cands = (interna ? fijos : reparto).filter((d) => permitidas(d).has(b.ruta));
    if (!cands.length) {
      b.lista.forEach((p) => pendiente(p, `Ruta ${b.ruta} sin chófer interno autorizado`, "Revisar autorización de chófer o subcontratar manualmente", "Ruta sin chófer autorizado"));
      continue;
    }
    const cabe = (d, kg, h) => {
      const u = uso.get(d.id);
      if (d.rol !== "fijo" && u.rutas.size && !u.rutas.has(b.ruta)) return false; // un reparto = una ruta al día
      return u.kg + kg <= cargaUtil(d) && u.h + (u.rutas.has(b.ruta) ? 0 : h) <= JORNADA_HORAS;
    };
    const poner = (d, lista, obs) => {
      const u = uso.get(d.id);
      u.kg += suma(lista);
      if (!u.rutas.has(b.ruta)) { u.rutas.add(b.ruta); u.h += b.h; }
      lista.forEach((p) => asignar(p, d, obs));
    };
    const partible = reglas.partible;
    const dueños = cands.filter((d) => uso.get(d.id).rutas.has(b.ruta));
    const pool = dueños.length && !(partible && b.ruta === partible.ruta) ? dueños : cands;

    if (partible && b.ruta === partible.ruta && b.lista.length >= partible.minPedidos && !dueños.length) {
      const libres = pool.filter((d) => cabe(d, 0, b.h)).sort(orden).slice(0, partible.maxChoferes);
      if (libres.length >= 2) {
        const { grupos, sinRepartir } = repartirPorCliente(b.lista, libres);
        if (grupos.length > 1) {
          grupos.forEach((g) => poner(g.d, g.lista, `${b.ruta} partida entre ${grupos.length} chóferes`));
          sinRepartir.forEach((p) => lgm(p, `${b.ruta}: exceso de kg subcontratado a LGM`));
          continue;
        }
      }
    }
    const elegido = pool.filter((d) => cabe(d, b.kg, b.h)).sort(orden)[0];
    if (elegido) { poner(elegido, b.lista); continue; }
    b.lista.forEach((p) => pendiente(p,
      `Ruta ${b.ruta} sin chófer disponible: ya tienen ruta, no están autorizados o no cabe por kg`,
      b.oblig ? "Prioritario: valorar subcontratación" : "Aplazar al día siguiente o subcontratar",
      b.oblig ? "Proponer subcontratación" : "Aplazar al día siguiente"));
  }
  return out;
}

// ---- Datos iniciales (se cargan UNA vez en Firestore; después se editan desde la app) ----
const R = (codigo, zona, horas, tipo) => ({ codigo, zona, horas, tipo });
export const CONFIG_INICIAL = {
  rutas: [
    R("R01", "Barcelona L (largo recorrido)", 10, "larga"), R("R02", "Barcelona C (corto)", 8, "larga"),
    R("R03", "Zaragoza", 8, "reparto"), R("R04", "Castellón", 4, "reparto"), R("R05", "Andalucía", 12, "larga"),
    R("R06", "Alicante", 5, "reparto"), R("R07", "Murcia/Baleares", 9, "larga"), R("R08", "Valencia", 3, "reparto"),
    R("R09", "Alcira/Gandía/Sueca", 4, "reparto"), R("R10", "Albacete", 6, "reparto"), R("R11", "Madrid", 9, "larga"),
    R("R12", "Embalaje especial (exportación)", 2, "interna"), R("R13", "Almacén interno", 2, "interna"),
    R("R15", "Embalaje crudo", 2, "interna"), R("R16", "Export (internacional)", 2, "export"),
    R("SUS MEDIOS", "Cliente recoge (plataforma)", 0, "recoge"),
  ],
  drivers: [
    { id: "andujar", nombre: "Antonio Andújar", matricula: "5227JPZ", tara: 16000, mma: 26000, tipo: "INTERNO", rol: "fijo", rutasPermitidas: ["R12", "R13", "R15"] },
    { id: "mellal", nombre: "Abdelkader Mellal", matricula: "7923FFC", tara: 19250, mma: 26000, tipo: "INTERNO", rol: "reparto", prioridad: 1, itv: "2026-10-16", tacografo: "2026-12-24", rutasPermitidas: ["R03", "R04", "R06", "R08", "R09", "R10"] },
    { id: "dedios", nombre: "Francisco de Dios", matricula: "3513DYZ", tara: 19250, mma: 26000, tipo: "INTERNO", rol: "reparto", prioridad: 2, itv: "2026-05-26", tacografo: "2027-02-04", rutasPermitidas: ["R03", "R04", "R06", "R08", "R09", "R10"] },
    { id: "fernandez", nombre: "Manolo Fernández", matricula: "5448DKL", tara: 19250, mma: 26000, tipo: "INTERNO", rol: "reparto", prioridad: 3, itv: "2026-06-11", tacografo: "2027-11-14", rutasPermitidas: ["R03", "R04", "R06", "R08", "R09", "R10"] },
  ],
  semana: { 1: [], 2: [], 3: [], 4: [], 5: [] },
  horasOverride: {},
  reglas: { clienteLGM: "SUNFER", partible: { ruta: "R08", minPedidos: 4, maxChoferes: 3 } },
};
