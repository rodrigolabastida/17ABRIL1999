import uvicorn
from fastapi import FastAPI, Request, Query, HTTPException
from fastapi.responses import PlainTextResponse
from database import Database
from scheduler import start_scheduler
import asyncio

app = FastAPI(title="Intlax Ingestor 2.0")

@app.on_event("startup")
async def startup_event():
    # Inicializar pool de DB
    await Database.get_pool()
    # Iniciar tareas programadas
    start_scheduler()
    print("✨ Sistema de Ingesta Intlax v2.0 Iniciado")

@app.get("/websub/callback", response_class=PlainTextResponse)
async def websub_verify(
    hub_mode: str = Query(None, alias="hub.mode"),
    hub_topic: str = Query(None, alias="hub.topic"),
    hub_challenge: str = Query(None, alias="hub.challenge"),
    hub_lease_seconds: int = Query(None, alias="hub.lease_seconds")
):
    """Maneja el 'Challenge' de WebSub para confirmar la suscripción"""
    if hub_mode == "subscribe" or hub_mode == "unsubscribe":
        print(f"🔗 WebSub Verification: {hub_mode} para {hub_topic}")
        return hub_challenge
    raise HTTPException(status_code=400, detail="Invalid hub.mode")

@app.post("/websub/callback")
async def websub_notify(request: Request):
    """Recibe las noticias en tiempo real (PUSH)"""
    body = await request.body()
    # Aquí se parsearía el XML/JSON del payload según el hub
    # Ejemplo rápido de logica de inserción:
    # await Database.execute("INSERT INTO noticias_raw ...", (...))
    print("📡 Notificación WebSub recibida!")
    return {"status": "accepted"}

@app.get("/status")
async def get_status():
    res = await Database.fetch_all("SELECT count(*) as total FROM noticias_raw")
    return {"status": "online", "database_records": res[0]['total']}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
