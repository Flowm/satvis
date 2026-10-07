// Real GCAT lines (2 October 2026), kept whole: the parsers resolve columns by name
// and must survive the ones they ignore. gcat.test.ts and refresh.test.ts share them.

/** satcat.tsv's header line, 42 columns. */
export const GCAT_CATALOG_HEADER =
  "#JCAT\tSatcat\tLaunch_Tag\tPiece\tType\tName\tPLName\tLDate\tParent\tSDate\tPrimary\tDDate\tStatus\tDest\tOwner\tState\tManufacturer\tBus\tMotor\tMass\tMassFlag\tDryMass\tDryFlag\tTotMass\tTotFlag\tLength\tLFlag\tDiameter\tDFlag\tSpan\tSpanFlag\tShape\tODate\tPerigee\tPF\tApogee\tAF\tInc\tIF\tOpOrbit\tOQUAL\tAltNames";

export const GCAT_CATALOG_LINES = {
  /** Grappled (`GRP`): still in orbit. */
  ISS: "S25544    \t25544\t1998-067\t1998-067A\tPPTH-MU     \tZarya\t77KM  No. 175-01\t1998 Nov 20\tS25545\t1998 Nov 20 0649:47\tEarth\t1998 Dec  6 2347:02\tGRP\tA06147\tJSC\tUS\tKHRR\t77KS\t-\t   20281 \t \t  19000 \t?\t   20351 \t \t  12.6 \t \t  4.2 \t?\t   23.9 \t \tCyl + 2 Pan\t1998 Dec 20\t     393\t \t     399\t \t 51.59 \t \tLLEO/I\t-\tISS FGB:P",
  /** Docked (`DK`) to the ISS; two makers, `KHRO/RKKE`. */
  NAUKA:
    "S49044    \t49044\t2021-066\t2021-066A\tPPTH-MU     \tNauka\t77KML No. 17901\t2021 Jul 21\tS49045\t2021 Jul 21 1508\tEarth\t2021 Jul 29 1329\tDK\tS26400\tRKKE\tRU\tKHRO/RKKE\tAlmaz\t-\t   19627 \t \t  19200 \t \t   20257 \t \t  13.2 \t \t  4.2 \t \t   23.9 \t \tStep Cyl + 2 Pan\t2021 Jul 23\t     224\t \t     362\t \t 51.58 \t \tLLEO/I\t-\tMLM-U",
  /** Reentered (`R`): dropped. */
  STARLINK_REENTERED:
    "S44235    \t44235\t2019-029\t2019-029A\tP      R  M \tStarlink 31\tStarlink V0.9-01\t2019 May 24\tA09431\t2019 May 24 0332\tEarth\t2020 Oct  1 1300?\tR\t-\tSPXS\tUS\tSPXS\tStarlink\t-\t     227 \t \t    219 \t?\t     227 \t \t   0.2 \t?\t  2.8 \t \t    9.0 \t?\tBox + pan\t2019 May 26\t     433\t \t     442\t \t 53.00 \t \tLLEO/I\t-\t-",
  /** `NNA`: no NORAD number, so nothing to key it by. */
  UNCATALOGUED:
    "S40899    \tNNA\t2015-049\t2015-049A\tP       ?   \tLuliang-1\tTiantuo-3\t2015 Sep 19\tS40913\t2015 Sep 19 2316\tEarth\t2025 Mar 31?\tR\t-\tNUDTC\tCN\tNUDTC\tTT2\t-\t      20 \t?\t     20 \t \t      20 \t?\t   0.7 \t \t  0.5 \t \t    0.7 \t \tBox\t2015 Sep 22\t     392\t \t     522\t \t 97.42 \t \tLLEO/S\t-\tTT-3",
  /** Reentered attached (`AR`): dropped. */
  SPUTNIK_2_ATTACHED_REENTERED:
    "S00003    \t00003\t1957 BET\t1957 BET 1\tP A         \t2-y ISZ\tPS-2\t1957 Nov  3\tA00002\t1957 Nov  3 0235\tEarth\t1958 Apr 14 0200?\tAR\t-\tOKB1\tSU\tOKB1\tPS\t-\t     508 \t \t    508 \t \t    8298 \t?\t   2.0 \t \t  1.0 \t \t    2.0 \t \tCone\t1957 Nov  3\t     211\t \t    1659\t \t 65.33 \t \tLEO/I\t-\t:RE,:RC",
};

/** The catalog: GCAT ends the header with a dated comment line. */
export function gcatCatalog(...lines: string[]): string {
  return [GCAT_CATALOG_HEADER, "# Updated 2026 Oct  2 2148:05", ...lines].join("\n");
}

/** orgs.tsv's header line. */
export const GCAT_ORGS_HEADER = "#Code\tUCode\tStateCode\tType\tClass\tTStart\tTStop\tShortName\tName\tLocation\tLongitude\tLatitude\tError\tParent\tShortEName\tEName\tUName";

export const GCAT_ORGS_LINES = {
  US: "US\tUS\tUS\tCY\tC\t1776 Jul  4\t-\tUSA\tUnited States of America\tWashington, DC\t    -77.0200 \t   38.9000 \t0.0200 \t-\tUSA\tUnited States of America\tUnited States of America",
  RU: "RU\tSU\tRU\tCY\tC\t1991 Dec 26\t-\tRossiya\tRossiyskaya Federatsiya\tMoskva, Rossiya\t     37.6200 \t   55.7500 \t0.0200 \t-\tRussia\tRussian Federation\t\u0420\u043e\u0441\u0441\u0438\u0439\u0441\u043a\u0430\u044f \u0424\u0435\u0434\u0435\u0440\u0430\u0446\u0438\u044f",
  "I-ESA":
    "I-ESA\tI-ESRO\tI-ESA\tIGO\tC\t1975 Apr 30\t*\tESA\tEuropean Space Agency\tParis\t      2.3000 \t   48.8600 \t0.0200 \t-\tESA\tEuropean Space Agency\tEuropean Space Agency",
  NASA: "NASA\tNASA\tUS\tO/LA/LV/PL/W/LS/S\tC\t1958 Oct  1\t-\tNASA\tNational Aeronautics and Space Administration\tWashington, D.C.\t    -77.0200 \t   38.9000 \t0.0200 \t-\t-\t-\tNational Aeronautics and Space Administration",
  RKKE: 'RKKE\tOKB1\tRU\tO/LA/LV/PL\tC\t1994\t-\tRKKE\tRKK Energiya\tKorolev:Podlipki, Moskva, Rossiya\t     37.8200 \t   55.9300 \t0.0200 \tFKA\t-\t-\t\u041e\u0410\u041e "\u0420\u0430\u043a\u0435\u0442\u043d\u043e-\u043a\u043e\u0441\u043c\u0438\u0447\u0435\u0441\u043a\u0430\u044f \u043a\u043e\u0440\u043f\u043e\u0440\u0430\u0446\u0438\u044f "\u042d\u043d\u0435\u0440\u0433\u0438\u044f" \u0438\u043c\u0435\u043d\u0438 \u0421.\u041f. \u041a\u043e\u0440\u043e\u043b\u0451\u0432\u0430"',
};

/** The organisations table also ends its header with a dated comment line. */
export function gcatOrgs(...lines: string[]): string {
  return [GCAT_ORGS_HEADER, "# Updated 2026 Oct  2 2146:37", ...lines].join("\n");
}

/** psatcat.tsv's header line. */
export const GCAT_PAYLOADS_HEADER =
  "#JCAT\tPiece\tName\tLDate\tTLast\tTOp\tTDate\tTF\tProgram\tPlane\tAtt\tMvr\tClass\tCategory\tResult\tControl\tDiscipline\tUNState\tUNReg\tUNPeriod\tUNPerigee\tUNApogee\tUNInc\tDispEpoch\tDispPeri\tDispApo\tDispInc\tComment";

/** The ISS and Nauka: both civil (`C`), both spaceships (`SS`). */
export const GCAT_PAYLOADS_LINES = {
  ISS: "S25544    \t1998-067A\tZarya Cargo Block\t1998 Nov 20 \t2023 Feb\t*\t*\t-\tTsM\t-\t-\tM\tC\tSS\tS\t-\t-\tUS\tST/SG/SER.E/614\t   89.5 \t     184\t     349\t 51.6 \t2026 Aug  7 \t     413\t     423\t 51.63 \t-",
  NAUKA:
    "S49044    \t2021-066A\tMnogotselevoy lab. md. Nauka\t2021 Jul 21 \t2023 Mar\t*\t*\t-\tTsM\t-\tP\tM\tC\tSS\tS\t-\t-\tRU\tST/SG/SER.E/1021\t   89.8 \t     194\t     363\t 51.6 \t2026 Aug  7 \t     413\t     423\t 51.63 \t-",
};

/** The payload table also ends its header with a dated comment line. */
export function gcatPayloads(...lines: string[]): string {
  return [GCAT_PAYLOADS_HEADER, "# Updated 2026 Oct  2 2148:10", ...lines].join("\n");
}
