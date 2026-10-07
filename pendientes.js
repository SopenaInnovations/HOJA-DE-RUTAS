// pendientes.js — lectura del Excel PEDIDOS_PENDIENTES del ERP + aviso de "posible resto".
// Entrada: filas como array de arrays (XLSX.utils.sheet_to_json(hoja, { header: 1 })).
import { asignarRuta } from "./asignador.js";

export const UMBRAL_RESTO = 0.10; // avisar si faltan por embalar hasta un 10% de las barras pedidas

const num = (v) => (typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", ".")) || 0);
const fecha = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));

export function leerPendientes(filas, cargaFecha) {
  const h = filas[0].map((x) => String(x ?? "").replace(/\s+/g, " ").trim());
  const col = (nombre, n = 0) => h.reduce((r, x, i) => (x === nombre && n-- === 0 ? i : r), -1);
  const c = {
    codCli: col("Cliente", 0), cliente: col("Cliente", 1), // la cabecera "Cliente" aparece dos veces: código y nombre
    ...Object.fromEntries(["ESTADO", "Fecha Pedido", "Domicilio Envío", "PERFIL", "KGS Pedidos", "BAR Pedidas", "BAR Servidas",
      "BAR Emp.", "Serie", "Pedido", "Línea", "Fecha Entrega", "Semana Entrega", "Estatus Pedido", "CERRADA", "DESDESG"]
      .map((n) => [n, col(n)])),
  };
  const faltan = Object.entries(c).filter(([, i]) => i < 0).map(([n]) => n);
  if (faltan.length) throw new Error(`Faltan columnas en el Excel: ${faltan.join(", ")}`);

  return filas.slice(1).filter((r) => r[c.Pedido] != null && r[c.Pedido] !== "").map((r) => {
    const ped = num(r[c["BAR Pedidas"]]), emp = num(r[c["BAR Emp."]]), kgsPed = num(r[c["KGS Pedidos"]]);
    return {
      id: `${r[c.Serie]}-${r[c.Pedido]}-${r[c["Línea"]]}`, // determinista: reimportar no duplica
      estado: r[c.ESTADO], fechaPedido: fecha(r[c["Fecha Pedido"]]), fechaEntrega: fecha(r[c["Fecha Entrega"]]),
      semanaEntrega: r[c["Semana Entrega"]], codigoCliente: String(r[c.codCli] ?? "").trim(), cliente: String(r[c.cliente] ?? "").trim(),
      domicilio: String(r[c["Domicilio Envío"]] ?? "").trim(), perfil: r[c.PERFIL], descripcion: r[c.DESDESG],
      pedido: r[c.Pedido], linea: r[c["Línea"]], serie: r[c.Serie],
      barPedidas: ped, barServidas: num(r[c["BAR Servidas"]]), barEmp: emp, bultos: emp,
      kgsPedidos: kgsPed, kgs: ped > 0 ? Math.round(kgsPed * Math.min(emp, ped) / ped * 100) / 100 : 0, // kg realmente embalados
      estatus: r[c["Estatus Pedido"]], cerrada: !!r[c.CERRADA], cargaFecha, status: "sin_asignar",
    };
  });
}

/** Posible resto: línea casi completa (faltan ≤ umbral de las barras pedidas) y no cerrada. */
export function avisoResto(p, umbral = UMBRAL_RESTO) {
  const falta = p.barPedidas - p.barEmp;
  if (p.cerrada || p.barPedidas <= 0 || falta <= 0) return null;
  const pct = falta / p.barPedidas;
  return pct <= umbral ? { falta, pct } : null;
}

export function procesarPendientes(filas, cargaFecha, indice, decisiones = {}) {
  return leerPendientes(filas, cargaFecha).map((p) => {
    const r = asignarRuta(p, indice, decisiones);
    return { ...p, ruta: r.ruta ?? "", metodoRuta: r.metodo, rutasCandidatas: r.candidatas, avisoResto: avisoResto(p) };
  });
}
