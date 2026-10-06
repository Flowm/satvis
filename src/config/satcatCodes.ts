// CelesTrak SATCAT code tables. Codes travel on the wire and labels resolve here: a code is
// 2-4 bytes against labels of up to 54, and a correction ships with a deploy, not a GP refresh.
// Every lookup falls back to the raw code, because these lists go stale.
//
// Sources, re-check when adding:
//   https://celestrak.org/satcat/launchsites.php  (launch site)
//   https://celestrak.org/satcat/status.php       (operational status)
//   https://celestrak.org/satcat/satcat-format.php (orbit type)
//
// This module must stay Cesium-free (node-env vitest exercises it).

/** SATCAT `LAUNCH_SITE`, without upstream's country suffix, which overflows the info panel. */
export const SATCAT_LAUNCH_SITE: Record<string, string> = {
  AFETR: "Cape Canaveral, Florida",
  AFWTR: "Vandenberg, California",
  ALCLC: "Alcântara, Brazil",
  ANDSP: "Andøya Spaceport, Norway",
  BOS: "Bowen Orbital Spaceport, Australia",
  CAS: "Canaries Airspace",
  DLS: "Dombarovskiy, Russia",
  ERAS: "Eastern Range Airspace",
  FRGUI: "Kourou, French Guiana",
  HGSTR: "Hammaguira, Algeria",
  JJSLA: "Jeju Island Sea Launch Area",
  JSC: "Jiuquan, China",
  KODAK: "Kodiak, Alaska",
  KSCUT: "Uchinoura, Japan",
  KWAJ: "Kwajalein Atoll",
  KYMSC: "Kapustin Yar, Russia",
  NSC: "Naro, Republic of Korea",
  PLMSC: "Plesetsk, Russia",
  RLLB: "Mahia Peninsula, New Zealand",
  SCSLA: "South China Sea Launch Area",
  SEAL: "Sea Launch Platform",
  SEMLS: "Semnan, Iran",
  SMTS: "Shahrud, Iran",
  SNMLP: "San Marco Platform, Kenya",
  SPKII: "Space Port Kii, Japan",
  SRILR: "Satish Dhawan, India",
  SUBL: "Submarine Launch Platform",
  SVOBO: "Svobodnyy, Russia",
  TAISC: "Taiyuan, China",
  TANSC: "Tanegashima, Japan",
  TYMSC: "Baikonur, Kazakhstan",
  UNK: "Unknown",
  VOSTO: "Vostochny, Russia",
  WLPIS: "Wallops Island, Virginia",
  WOMRA: "Woomera, Australia",
  WRAS: "Western Range Airspace",
  WSC: "Wenchang, China",
  XICLF: "Xichang, China",
  YAVNE: "Yavne, Israel",
  YSLA: "Yellow Sea Launch Area",
  YUN: "Yunsong, North Korea",
};

/**
 * SATCAT `OPS_STATUS_CODE`. CelesTrak counts +, P, B, S and X as active, which does not imply powered.
 */
export const SATCAT_OPS_STATUS: Record<string, string> = {
  "+": "Operational",
  "-": "Nonoperational",
  P: "Partially operational",
  B: "Backup/standby",
  S: "Spare",
  X: "Extended mission",
  D: "Decayed",
  "?": "Unknown",
};

/** SATCAT `ORBIT_TYPE`. getSatelliteInfo hides the common `ORB`. */
export const SATCAT_ORBIT_TYPE: Record<string, string> = {
  ORB: "Orbiting",
  LAN: "Landed",
  IMP: "Impacted",
  DOC: "Docked",
  "R/T": "Roundtrip",
};

/** Falls back to the code itself. */
export function satcatLabel(table: Record<string, string>, code: string): string {
  return table[code] ?? code;
}
