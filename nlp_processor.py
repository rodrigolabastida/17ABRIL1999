import sys
import json

MUNICIPIOS_TLAXCALA = [
    "Acuamanala de Miguel Hidalgo", "Amaxac de Guerrero", "Apetatitlán de Antonio Carvajal", "Apizaco", "Atlangatepec",
    "Altzayanca", "Benito Juárez", "Calpulalpan", "Chiautempan", "Contla de Juan Cuamatzi",
    "Cuapiaxtla", "Cuaxomulco", "El Carmen Tequexquitla", "Emiliano Zapata", "Españita",
    "Huamantla", "Ixtacuixtla de Mariano Matamoros", "Ixtenco", "La Magdalena Tlaltelulco", "Lázaro Cárdenas",
    "Mazatecochco de José María Morelos", "Muñoz de Domingo Arenas", "Nanacamilpa de Mariano Arista", "Nativitas", "Panotla",
    "Papalotla de Xicohténcatl", "San Damián Texoloc", "San Francisco Tetlanohcan", "San Jerónimo Zacualpan", "San José Teacalco",
    "San Juan Huactzinco", "San Lorenzo Axocomanitla", "San Lucas Tecopilco", "San Pablo del Monte", "Sanctórum de Lázaro Cárdenas",
    "Santa Ana Nopalucan", "Santa Apolonia Teacalco", "Santa Catarina Ayometla", "Santa Cruz Quilehtla", "Santa Cruz Tlaxcala",
    "Santa Isabel Xiloxoxtla", "Tenancingo", "Teolocholco", "Tepetitla de Lardizábal", "Tepeyanco",
    "Terrenate", "Tetla de la Solidaridad", "Tetlatlahuca", "Tlaxcala", "Tlaxco",
    "Tocatlán", "Totolac", "Tzompantepec", "Xaloztoc", "Xaltocan",
    "Xicohtzinco", "Yauhquemehcan", "Zacatelco", "Zitlaltépec de Trinidad Sánchez Santos"
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
