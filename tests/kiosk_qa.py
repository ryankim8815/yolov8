"""Isolated real API/browser fixture. No camera, voice helper or robot SDK."""
import os
from pathlib import Path
from contextlib import asynccontextmanager
from app.config import Settings
from app.main import create_app


def create_qa_app():
    state=Path(os.environ['ROBOT_STATE_DIR']).resolve()
    if not str(state).startswith(('/private/tmp/','/tmp/')) or os.getenv('ROBOT_ACCESS_BACKEND')!='ros' or os.getenv('ROBOT_ROS_PC_IP'):
        raise RuntimeError('Temporary state and hardware-disabled environment required')
    app=create_app(Settings(camera_autostart=False,voice_enabled=False),state_root=state)
    original=app.router.lifespan_context
    @asynccontextmanager
    async def lifespan(application):
        async with original(application):
            store=application.state.pipeline.store
            with store.write_transaction():
                store.db.execute("INSERT INTO customers(name,kiosk_guest) VALUES ('키오스크 방문 고객',1)")
                store.db.execute("INSERT INTO customers(name) VALUES ('홍길동')")
            yield
    app.router.lifespan_context=lifespan
    return app
