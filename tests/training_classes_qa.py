"""Isolated UI fixture: fake PT files and no camera, microphone or training worker."""
import sys
import tempfile
from pathlib import Path
from contextlib import asynccontextmanager

from app.main import create_app
from tests.fakes import settings
from tests.test_runtime import factory
from tests.test_training_classes import fixtures


def create_qa_app():
    application=create_app(settings(camera_autostart=False),factory,Path(tempfile.mkdtemp(prefix='class-selection-qa-')))
    original=application.router.lifespan_context
    @asynccontextmanager
    async def lifespan(app):
        async with original(app):
            rt=app.state.pipeline
            parent,base,extra,selection=fixtures(rt.store)
            for collection in rt.store.list('collection'):
                rt.store.update('collection',collection['id'],created_at='2026-11-11T00:00:00+00:00')
            rt.train_python=Path(sys.executable);rt._spawn=lambda *_:None
            app.state.qa=dict(parent=parent,base=base,extra=extra,selection=selection)
            yield
    application.router.lifespan_context=lifespan
    @application.get('/__qa/state')
    def state():return application.state.qa
    return application
