// asignador.js — decide la ruta de un pedido a partir del maestro RUTAS X CLIENTE.
// Un mismo cliente puede tener varias rutas según la dirección de entrega, por eso
// se resuelve por (código de cliente + domicilio), no solo por cliente.
import { normalizarRuta } from "./motor.js";

const STOP = new Set("C CL CALLE CARRER AV AVDA AVENIDA PI POL IND POLIGONO DE DEL LA EL LOS LAS NO N S L Y".split(" "));
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
  .replace(/[^A-Z0-9]+/g, " ").trim();
const tokens = (s) => norm(s).split(" ").filter((t) => t && !STOP.has(t));
const casa = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** "NOMBRE - LOCALIDAD - 46600 - ESPAÑA" → { loc, cp } (cp a 5 dígitos). */
export function partirDomicilio(d) {
  const p = String(d ?? "").split(" - ").map((x) => x.trim());
  if (p.length < 3) return {};
  const cp = p.find((x, i) => i >= 2 && /^\d{3,5}$/.test(x));
  return { loc: norm(p[1]), cp: cp ? cp.padStart(5, "0") : "" };
}

export function construirIndice(maestro) {
  const porCodigo = new Map(), porNombre = new Map();
  for (const m of maestro) {
    const fila = { ...m, ruta: normalizarRuta(m.ruta), tk: tokens(`${m.direccion} ${m.localidad} ${m.cp}`) };
    if (m.codigo) porCodigo.set(m.codigo, [...(porCodigo.get(m.codigo) ?? []), fila]);
    const k = norm(m.cliente);
    porNombre.set(k, [...(porNombre.get(k) ?? []), fila]);
  }
  return { porCodigo, porNombre };
}

export const claveCliente = (p) => String(p.codigoCliente ?? "").trim() || norm(p.cliente);
export const claveDecision = (p) => `${String(p.codigoCliente ?? "").trim() || norm(p.cliente)}|${norm(p.domicilio)}`;

/** @returns {{ruta: string|null, metodo: string, candidatas?: string[]}}
 *  metodo: decision | cliente | domicilio | ambigua | sin_cliente */
export function asignarRuta(pedido, indice, decisiones = {}) {
  // decisión por cliente+domicilio (más específica) o por cliente completo
  const dec = decisiones[claveDecision(pedido)] ?? decisiones[claveCliente(pedido)];
  if (dec) return { ruta: normalizarRuta(dec), metodo: "decision" };

  const cod = String(pedido.codigoCliente ?? "").trim();
  const filas = (cod && indice.porCodigo.get(cod)) || indice.porNombre.get(norm(pedido.cliente));
  if (!filas?.length) return { ruta: null, metodo: "sin_cliente" };

  const rutas = [...new Set(filas.map((f) => f.ruta))];
  if (rutas.length === 1) return { ruta: rutas[0], metodo: "cliente" };

  const { loc, cp } = partirDomicilio(pedido.domicilio);
  const dom = tokens(pedido.domicilio);
  const puntos = new Map();
  for (const f of filas) {
    let s;
    if (loc || cp) { // formato del ERP: sin calle, se compara localidad y código postal
      const okCp = cp && f.cp && cp === f.cp, okLoc = loc && casa(norm(f.localidad), loc);
      s = (okCp ? 0.6 : 0) + (okLoc ? 0.4 : 0);
    } else {
      s = f.tk.length ? f.tk.filter((t) => dom.some((d) => casa(t, d))).length / f.tk.length : 0;
    }
    puntos.set(f.ruta, Math.max(puntos.get(f.ruta) ?? 0, s));
  }
  const orden = [...puntos].sort((a, b) => b[1] - a[1]);
  const [mejor, segundo] = [orden[0], orden[1]];
  if (mejor[1] >= 0.5 && mejor[1] - (segundo?.[1] ?? 0) >= 0.2) return { ruta: mejor[0], metodo: "domicilio" };
  return { ruta: null, metodo: "ambigua", candidatas: orden.map(([r]) => r) };
}
