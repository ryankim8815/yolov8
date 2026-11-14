"""Select Chrome's authorized online STT, even when SODA packs are installed."""


def install_online_speech_policy(application):
    @application.middleware('http')
    async def online_speech_policy(request, call_next):
        response = await call_next(request)
        # processLocally=False allows cloud fallback but Chrome still prefers SODA.
        # The document policy also makes Blink's on_device request parameter false.
        existing=response.headers.get('Permissions-Policy','')
        directives=[p.strip() for p in existing.split(',') if p.strip() and p.partition('=')[0].strip()!='on-device-speech-recognition']
        response.headers['Permissions-Policy'] = ', '.join([*directives,'on-device-speech-recognition=()'])
        if request.url.path.startswith('/static/') and request.url.path.endswith(('.js','.css')):
            response.headers['Cache-Control']='no-cache'
        return response
