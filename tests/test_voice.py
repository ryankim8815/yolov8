import asyncio
import tempfile
import threading
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.packing import Packing
from app.store import Store
from app.voice import Voice
from app.voice_commands import INTENTS, normalized, packing_answer


class VoiceCommandsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(directory.name)
        self.addCleanup(self.store.close)
        self.packing = Packing(self.store)

    def test_queries_mutations_and_exact_phrases(self):
        self.assertIn("생수 4개", packing_answer(self.packing, "query-stock").text)
        self.assertIn("123번", packing_answer(self.packing, "query-order").text)
        for phrase, paused in [("멈춰!", True), ("피킹 재개해 줘.", False)]:
            packing_answer(self.packing, INTENTS[normalized(phrase)])
            self.assertEqual(self.packing.order(123)["paused"], paused)
        self.assertNotIn(normalized("피킹 재개하지 마"), INTENTS)
        self.assertEqual(INTENTS[normalized("응, 주문 내역 알려줘.")], "query-order")
        self.assertEqual(INTENTS[normalized("네, 재고 조회해 줘.")], "query-stock")
        self.assertNotIn(normalized("응, 주문 확정"), INTENTS)
        self.assertNotIn(normalized("최고 알려줘"), INTENTS)
        self.assertNotIn(normalized("이건 주문 확정 아니야"), INTENTS)
        self.assertTrue(packing_answer(self.packing, "cmd-order").confirm)
        self.assertIn("취소했습니다", packing_answer(self.packing, "discard-order", confirming=True).text)
        self.assertIn("없습니다", packing_answer(self.packing, "confirm-order").text)
        for _ in range(2):
            packing_answer(self.packing, "confirm-order", confirming=True)
        self.assertFalse(packing_answer(self.packing, "cmd-order").confirm)
        self.assertEqual(len([e for e in self.store.list("packing_event") if "#124" in e["message"]]), 1)


class BrowserVoiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(directory.name)
        self.addCleanup(self.store.close)
        self.voice = Voice(Packing(self.store), True, barge_in=True)
        self.voice.browser = object()
        self.voice.commands = asyncio.Queue()

    async def emit(self, event, text="", **fields):
        await self.voice.event(dict(session=self.voice.session, turn=self.voice.turn, event=event, text=text, **fields))

    async def hear(self, text):
        await self.emit("listening")
        await self.emit("final", text)

    async def test_full_protocol_duplicate_echo_late_confirmation_and_timeout(self):
        v=self.voice
        first,duplicate=await asyncio.gather(v.wake(),v.wake())
        self.assertEqual(first,duplicate)
        old=v.session
        await self.hear("예시 주문")
        self.assertTrue(v.confirming)
        await self.emit("final","주문 확정")  # speaker echo and repeated result while speaking
        self.assertEqual(len(self.store.list("packing_order")),1)
        await self.emit("spoken")
        self.assertEqual(v.turn,2)
        await self.emit("listening")
        await self.emit("timeout")
        self.assertFalse(v.confirming)
        await v.wake()
        await v.event(dict(event="final",text="주문 확정",session=old,turn=1))
        await self.hear("주문 확정")
        self.assertEqual(len(self.store.list("packing_order")),1)
        await self.emit("spoken")
        await self.hear("예시 주문")
        await self.emit("spoken")
        await self.hear("주문 확정")
        await self.emit("final","주문 확정")
        self.assertEqual(len(self.store.list("packing_order")),2)
        await self.emit("spoken")
        await self.hear("대화 종료")
        self.assertEqual(v.state,"idle")
        self.assertFalse(v.status()["barge_in"])

    async def test_stop_discards_confirmation_and_late_playback(self):
        v=self.voice
        await v.wake();await self.hear("예시 주문")
        old=dict(session=v.session,turn=v.turn)
        await v.stop(session_only=True)
        await v.event(dict(**old,event="spoken"))
        await v.event(dict(**old,event="final",text="주문 확정"))
        self.assertEqual(v.state,"idle")
        self.assertFalse(v.confirming)
        self.assertEqual(len(self.store.list("packing_order")),1)
        self.assertEqual((await v.commands.get())["action"],"listen")
        self.assertEqual((await v.commands.get())["action"],"speak")
        self.assertEqual((await v.commands.get())["action"],"stop")

    async def test_stop_while_processing_does_not_play_late_answer(self):
        v=self.voice;started,release=threading.Event(),threading.Event()
        def slow(*args,**kwargs):
            started.set();assert release.wait(3)
            return packing_answer(*args,**kwargs)
        await v.wake();await self.emit("listening")
        with patch("app.voice.packing_answer",slow):
            task=asyncio.create_task(self.emit("final","예시 주문"))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait,2))
                await v.stop(session_only=True)
                await v.wake() # new conversation cannot receive the old answer
            finally:release.set()
            await task
        self.assertEqual(v.reply,"")
        self.assertFalse(v.confirming)
        self.assertEqual(v.state,"preparing")

    async def test_shutdown_drains_accepted_work_after_browser_task_is_cancelled(self):
        v=self.voice;started,release=threading.Event(),threading.Event()
        def slow(*args,**kwargs):
            started.set();assert release.wait(3)
            return packing_answer(*args,**kwargs)
        await v.wake();await self.emit('listening')
        with patch('app.voice.packing_answer',slow):
            task=asyncio.create_task(self.emit('final','예시 주문'))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait,2))
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):await task
                shutdown=asyncio.create_task(v.stop())
                await asyncio.sleep(.01)
                self.assertFalse(shutdown.done())
            finally:release.set()
            await shutdown
        self.assertEqual(v.state,'idle')
        self.assertFalse(v.confirming)
        self.assertFalse(v.processing)


class VoiceAPITests(unittest.TestCase):
    def client(self,state,enabled=True):
        return TestClient(create_app(Settings(camera_autostart=False,voice_enabled=enabled),state_root=state))

    def attach(self,client,origin="http://testserver"):
        return client.websocket_connect("/api/voice/browser",headers={"origin":origin})

    def ready(self,ws):
        ws.send_json({"event":"ready"})
        ready=ws.receive_json()
        self.assertEqual(ready["action"],"ready")
        self.assertEqual(len(ready["client_id"]),32)
        return ready["client_id"]

    def test_websocket_packing_reply_disconnect_and_recovery(self):
        with tempfile.TemporaryDirectory() as state,self.client(state) as c:
            self.assertEqual(c.post("/api/voice/wake").status_code,503)
            with self.attach(c) as ws:
                self.ready(ws)
                wake=c.post("/api/voice/wake").json()
                command=ws.receive_json()
                self.assertEqual(command["action"],"listen")
                def emit(event,text=""):
                    ws.send_json(dict(event=event,text=text,session=command["session"],turn=command["turn"]))
                emit("listening");emit("final","예시 주문")
                reply=ws.receive_json()
                self.assertEqual(reply["action"],"speak")
                self.assertTrue(c.app.state.voice.confirming)
                self.assertEqual(c.get("/api/voice/history").json()["status"]["provider"],"chrome")
                self.assertEqual(c.post("/api/voice/stop",headers={"sec-fetch-site":"cross-site"}).status_code,403)
                self.assertEqual(c.post("/api/voice/stop").json()["state"],"idle")
                self.assertEqual(ws.receive_json()["action"],"stop")
                self.assertFalse(c.app.state.voice.confirming)
                c.post("/api/voice/wake");command=ws.receive_json()
                self.assertNotEqual(command["session"],wake["session_id"])
            # A synchronization call waits until websocket cleanup has run.
            c.portal.call(asyncio.sleep,.02)
            self.assertFalse(c.get("/api/voice/status").json()["can_stop"])
            with self.attach(c) as ws:self.ready(ws)

    def test_single_owner_and_robot_event_turns(self):
        with tempfile.TemporaryDirectory() as state,self.client(state) as c,self.attach(c) as ws:
            self.ready(ws);c.post("/api/voice/robot/start");command=ws.receive_json()
            with self.attach(c) as other:self.assertEqual(other.receive_json()["action"],"error")
            ws.send_json(dict(event="listening",session=command["session"],turn=1))
            event=dict(event="final",text="로봇 이동",session=command["session"],turn=1)
            ws.send_json(event);self.assertEqual(ws.receive_json()["turn"],2)
            ws.send_json(event)
            result=c.get("/api/voice/robot/events").json()
            self.assertEqual(len(result["events"]),1)
            self.assertEqual(result["events"][0]["text"],"로봇 이동")
            self.assertEqual(c.post("/api/voice/wake").status_code,409)
            self.assertEqual(c.post("/api/voice/robot/stop",headers={"x-voice-session":"old"}).status_code,409)
            c.post("/api/voice/robot/stop",headers={"x-voice-session":command["session"]})
            self.assertEqual(ws.receive_json()["action"],"stop")

    def test_origin_disabled_and_malformed_events(self):
        from starlette.websockets import WebSocketDisconnect
        with tempfile.TemporaryDirectory() as state,self.client(state) as c:
            for origin in ("https://evil.example","null",""):
                with self.assertRaises(WebSocketDisconnect):
                    with self.attach(c,origin):pass
            with self.attach(c) as ws:
                self.ready(ws);c.post("/api/voice/wake");ws.receive_json()
                ws.send_json({"event":"final","text":"a"*2001})
                with self.assertRaises(WebSocketDisconnect):ws.receive_json()
            self.assertFalse(c.app.state.voice.confirming)
        with tempfile.TemporaryDirectory() as state,self.client(state,False) as c:
            with self.attach(c) as ws:self.assertEqual(ws.receive_json()["action"],"error")
            self.assertEqual(c.post("/api/voice/stop").json()["state"],"disabled")
            self.assertEqual(c.post("/api/voice/wake").status_code,503)

    def test_missing_browser_heartbeat_releases_session(self):
        from starlette.websockets import WebSocketDisconnect
        with tempfile.TemporaryDirectory() as state,self.client(state) as c:
            with patch('app.voice.BROWSER_TIMEOUT',.1),self.attach(c) as ws:
                self.ready(ws);c.post('/api/voice/wake');ws.receive_json()
                with self.assertRaises(WebSocketDisconnect):ws.receive_json()
            self.assertFalse(c.app.state.voice.status()['can_stop'])
            self.assertFalse(c.app.state.voice.status()['browser_connected'])

    def test_idle_browser_takeover_cannot_route_an_old_tab_wake_to_new_microphone(self):
        with tempfile.TemporaryDirectory() as state,self.client(state) as c,self.attach(c) as first:
            old=self.ready(first)
            with self.attach(c) as second:
                current=self.ready(second)
                self.assertNotEqual(old,current)
                self.assertEqual(c.post('/api/voice/wake',headers={'X-Voice-Client':old}).status_code,409)
                self.assertFalse(c.app.state.voice.session)
                response=c.post('/api/voice/wake',headers={'X-Voice-Client':current})
                self.assertEqual(response.status_code,200)
                self.assertEqual(second.receive_json()['session'],response.json()['session_id'])

    def test_online_policy_is_applied_to_native_and_robot_documents(self):
        from app.robot_web import create_robot_app
        policy='on-device-speech-recognition=()'
        with tempfile.TemporaryDirectory() as state,self.client(state,False) as c:
            for path in ('/','/robot','/healthz','/static/chrome-voice.js'):
                self.assertEqual(c.get(path).headers.get('Permissions-Policy'),policy)
            self.assertEqual(c.get('/static/chrome-voice.js').headers.get('Cache-Control'),'no-cache')
        # Existing restrictions must remain intact when the STT policy is added.
        from fastapi.responses import HTMLResponse
        application=create_app(Settings(camera_autostart=False),state_root=state)
        @application.get('/__policy')
        async def document():return HTMLResponse('',headers={'Permissions-Policy':'microphone=()'})
        c=TestClient(application)
        try:self.assertEqual(c.get('/__policy').headers['Permissions-Policy'],'microphone=(), '+policy)
        finally:c.close()
        # Document headers can be checked without starting the robot runtime.
        c=TestClient(create_robot_app())
        try:
            for path in ('/','/healthz','/static/chrome-voice.js'):
                self.assertEqual(c.get(path).headers.get('Permissions-Policy'),policy)
        finally:c.close()

    def test_barge_in_environment_is_accepted_but_browser_uses_half_duplex(self):
        for value in ("0","1"):
            with patch.dict("os.environ",YOLO_VOICE_BARGE_IN=value):
                settings=Settings.from_env()
                self.assertFalse(Voice(None,True,barge_in=settings.voice_barge_in).barge_in)
        with patch.dict("os.environ",YOLO_VOICE_BARGE_IN="yes"):
            with self.assertRaisesRegex(ValueError,"YOLO_VOICE_BARGE_IN"):Settings.from_env()
