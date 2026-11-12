import asyncio
import time

from app.store import DomainError
from tests.test_robot_scenario import scenario
from tests.test_robot_presets import BASE,create


def fake_audio(monkeypatch):
    active={'id':None,'starts':0}
    def native(action,after=0,*,session_id=None):
        if action=='start':active.update(id='asr',starts=active['starts']+1)
        if action=='stop':active['id']=None
        return dict(session_id=active['id'],context='robot',state='listening' if active['id'] else 'idle',cursor=0,events=[])
    monkeypatch.setattr('app.robot_preset_voice.native_voice',native)
    return active


def test_explicit_saved_preset_can_be_prepared_without_alias_or_hardware(scenario,monkeypatch):
    client,calls,*_=scenario;audio=fake_audio(monkeypatch)
    p=create(client,[dict(kind='wait',seconds=.1)])
    result=client.post('/api/robot/preset-voice/preset-request',json=dict(preset_id=p['id'],revision=p['revision'],target='simulation'))
    assert result.status_code==200,result.text
    ticket=result.json()['pending'];assert ticket['target']=='simulation' and 0<ticket['expires_in']<=30
    client.get('/api/robot/preset-voice/status?heartbeat=true')
    assert not client.get(BASE+'/'+p['id']).json()['voice_enabled']
    response=client.post('/api/robot/preset-voice/approve',json=dict(approval_id=ticket['approval_id']))
    assert response.status_code==200 and response.json()['recipe']['steps'][0]['kind']=='wait'
    assert not calls
    client.post('/api/robot/preset-voice/stop',json={})


def test_invalid_coordinates_or_revision_do_not_open_microphone(scenario,monkeypatch):
    client,calls,*_=scenario;audio=fake_audio(monkeypatch)
    p=create(client,[dict(kind='movej',name='미교시 이동')])
    for revision in (p['revision'],'outdated'):
        response=client.post('/api/robot/preset-voice/preset-request',json=dict(preset_id=p['id'],revision=revision,target='simulation'))
        assert response.status_code in {409,412}
    assert audio['starts']==0 and not calls


def test_explicit_voice_confirmation_cannot_be_replaced_by_screen_or_text(scenario,monkeypatch):
    client,calls,*_=scenario;audio=fake_audio(monkeypatch)
    p=create(client,[dict(kind='wait',seconds=.1)],confirmation='voice')
    v=client.app.state.robot.presets.voice
    result=client.post('/api/robot/preset-voice/preset-request',json=dict(preset_id=p['id'],revision=p['revision'],target='simulation')).json()
    identifier=result['pending']['approval_id']
    client.get('/api/robot/preset-voice/status?heartbeat=true')
    assert client.post('/api/robot/preset-voice/approve',json=dict(approval_id=identifier)).status_code==409
    assert client.post('/api/robot/preset-voice/test',json=dict(text='로봇 실행')).status_code==409
    client.portal.call(v.hear,dict(text='로봇 실행',sequence=1,session_id='asr'))
    assert v.simulation and not v.pending and not calls
    client.post('/api/robot/preset-voice/stop',json={})


def test_explicit_confirmation_expires_and_settings_change_revokes_it(scenario,monkeypatch):
    client,calls,*_=scenario;fake_audio(monkeypatch)
    p=create(client,[dict(kind='wait')]);v=client.app.state.robot.presets.voice
    body=dict(preset_id=p['id'],revision=p['revision'],target='simulation')
    first=client.post('/api/robot/preset-voice/preset-request',json=body).json()['pending']['approval_id']
    v.pending['deadline']=time.monotonic()-1
    assert client.post('/api/robot/preset-voice/approve',json=dict(approval_id=first)).status_code==409
    second=client.post('/api/robot/preset-voice/preset-request',json=body).json()['pending']['approval_id']
    p['name']='변경된 경로';assert client.put(BASE+'/'+p['id'],json=p).is_success
    assert client.post('/api/robot/preset-voice/approve',json=dict(approval_id=second)).status_code==409
    assert not v.simulation and not calls
    client.post('/api/robot/preset-voice/stop',json={})
