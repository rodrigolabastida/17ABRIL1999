import sys
import json

MUNICIPIOS_TLAXCALA = [
    "Calpulalpan", "Tlaxcala", "Apizaco", "Huamantla", "Chiautempan", 
    "Zacatelco", "San Pablo del Monte", "Tlaxco", "Contla", "Ixtacuixtla",
    "Panotla", "Tetla", "Totolac", "Papalotla", "Yauhquemehcan"
]

KEYWORDS_ALTO_IMPACTO = ["accidente", "balacera", "robo", "emergencia", "fallece", "muerto", "choque", "homicidio", "ejecutado"]
KEYWORDS_LOCAL = ["inaugura", "obra", "mercado", "feria", "economia", "empleo", "clima", "turismo", "comunidad"]
KEYWORDS_POLITICA = ["partido", "voto", "diputado", "senador", "eleccion", "congreso", "cabildo", "gobernador", "morena", "pri", "pan"]

def analyze_news(title, summary):
    text = (title + " " + (summary or "")).lower()
    
    # 1. Clasificación Temática
    categoria = 'GENERAL'
    multiplicador = 1.0
    
    if any(k in text for k in KEYWORDS_ALTO_IMPACTO):
        categoria = 'ALTO_IMPACTO'
        multiplicador = 1.5
    elif any(k in text for k in KEYWORDS_LOCAL):
        categoria = 'LOCAL'
        multiplicador = 1.2
    elif any(k in text for k in KEYWORDS_POLITICA):
        categoria = 'POLITICA'
        multiplicador = 0.7
        
    # 2. Extracción Geográfica
    municipio = 'Tlaxcala' # Default
    for m in MUNICIPIOS_TLAXCALA:
        if m.lower() in text:
            municipio = m
            break
            
    return {
        "categoria": categoria,
        "multiplicador": multiplicador,
        "municipio": municipio
    }

if __name__ == "__main__":
    try:
        # Lee datos de la noticia por STDIN para integrarse con Node.js
        input_data = json.load(sys.stdin)
        result = analyze_news(input_data.get('title', ''), input_data.get('summary', ''))
        print(json.dumps(result))
    except Exception as e:
        # Fallback en caso de error
        print(json.dumps({
            "categoria": "GENERAL",
            "multiplicador": 1.0,
            "municipio": "Tlaxcala",
            "error": str(e)
        }))
