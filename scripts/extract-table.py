import sys, json, os, re
import pandas as pd
path = sys.argv[sys.argv.index("--file")+1] if "--file" in sys.argv else ""
field = sys.argv[sys.argv.index("--field")+1] if "--field" in sys.argv else ""
def num(x):
    try: return float(str(x).replace(",", "").replace("，", ""))
    except Exception: return None
out = {"ok": False, "candidates": [], "candidateDetails": [], "headers": [], "error": ""}
try:
    if path.lower().endswith((".xlsx", ".xls")):
        df = pd.read_excel(path, sheet_name=0)
    elif path.lower().endswith((".csv", ".tsv")):
        df = pd.read_csv(path, sep="\t" if path.lower().endswith(".tsv") else ",")
    else:
        out["error"] = "unsupported file type; use csv/xlsx"
        print(json.dumps(out, ensure_ascii=False)); sys.exit(0)
    out["headers"] = [str(c) for c in df.columns]
    cols = list(df.columns)
    target = None
    for c in cols:
        if field and (field.lower() in str(c).lower() or str(c).lower() in field.lower()):
            target = c; break
    if target is None and len(cols) == 1: target = cols[0]
    if target is not None:
        vals = []
        for ri, v in enumerate(df[target].tolist()):
            n = num(v)
            if n is not None:
                vals.append(n)
                out["candidateDetails"].append({"value": n, "row": ri + 2, "column": str(target)})
        out["candidates"] = vals[:10]
        out["candidateDetails"] = out["candidateDetails"][:10]
    else:
        for c in cols:
            vals = []
            for ri, v in enumerate(df[c].tolist()):
                n = num(v)
                if n is not None:
                    vals.append(n)
                    out["candidateDetails"].append({"value": n, "row": ri + 2, "column": str(c)})
            if vals: out["candidates"].extend(vals[:3])
        out["candidateDetails"] = out["candidateDetails"][:10]
    out["ok"] = True
except Exception as e:
    out["error"] = str(e)[:300]
print(json.dumps(out, ensure_ascii=False))
