# PoC Python network tap (PEP 578 audit hook), put on PYTHONPATH so `site` imports it at startup.
# Product-like code kept inside the PoC folder (the user allowed Python for this PoC). Python >= 3.8.
#
# Observes audit events only - no monkeypatching:
#   socket.getaddrinfo (host, port, ...)    -> dns
#   socket.connect     (sock, address)      -> connect (host from the last getaddrinfo of the thread)
#   urllib.Request     (url, data, headers, method)
#   http.client.send   (conn, data)         -> bytes out, summed per connection
#   socket.bind        (sock, address)      -> a bind to a fixed (non-zero) port: this process is a "service"
#                                              (port 0 binds are probes: urllib3 binds ('::1', 0) on import)
# dns and http.client.connect are folded into the connect record (one record per TCP connection).
# There are no response events: status, bytes in and duration are unknown to an audit hook.
#
# Fail-open: an exception escaping an audit hook aborts the audited operation (the user's connect
# would fail), so the whole hook body is guarded. Env (same names as the Node tap):
#   LOGHUB_NET_TAP=0, LOGHUB_NET_TAP_DIR, LOGHUB_NET_TAP_LOOPBACK=1 (PoC), LOGHUB_NET_TAP_MAX_RECORDS,
#   LOGHUB_NET_TAP_MAX_BYTES, LOGHUB_NET_TAP_SKIP=1, LOGHUB_NET_TAP_EXCLUDE, LOGHUB_NET_TAP_SERVICE_AFTER_S,
#   LOGHUB_NET_TAP_TEST_THROW=guarded|raw (PoC: inject a bug)


def _loghub_install():
    import os
    import sys

    env = os.environ
    if env.get('LOGHUB_NET_TAP') == '0' or env.get('LOGHUB_NET_TAP_SKIP') == '1':
        return
    out_dir = env.get('LOGHUB_NET_TAP_DIR')
    if not out_dir:
        return

    # Startup cost matters (every python process pays it): `threading` (~6 ms: functools, collections)
    # is replaced by the builtin `_thread`, and json (~13 ms: pulls in `re`) is imported on the first
    # record only.
    import _thread
    import time
    jsonmod = []

    def dumps(o):
        if not jsonmod:
            import json
            jsonmod.append(json)
        return jsonmod[0].dumps(o, default=str)

    max_records = int(env.get('LOGHUB_NET_TAP_MAX_RECORDS') or 500)
    max_bytes = int(env.get('LOGHUB_NET_TAP_MAX_BYTES') or 262144)
    keep_loopback = env.get('LOGHUB_NET_TAP_LOOPBACK') == '1'
    service_after = float(env.get('LOGHUB_NET_TAP_SERVICE_AFTER_S') or 30)
    exclude = [x.strip().lower() for x in (env.get('LOGHUB_NET_TAP_EXCLUDE') or '').split(',') if x.strip()]
    test_throw = env.get('LOGHUB_NET_TAP_TEST_THROW') or ''
    t_start = time.monotonic()
    st = {'fd': -1, 'disabled': False, 'records': 0, 'bytes': 0, 'dropped': 0, 'marked': False, 'service': False}
    lock = _thread.allocate_lock()
    tls = _thread._local()
    sent = {}  # id(conn) -> bytes
    WATCH = ('socket.getaddrinfo', 'socket.connect', 'urllib.Request', 'http.client.send', 'socket.bind')

    def loopback(host):
        if keep_loopback or not host:
            return False
        h = str(host).strip('[]').lower()
        return h in ('localhost', '::1', '0.0.0.0') or h.startswith('127.') or h.endswith('.localhost')

    def excluded(host, port):
        if not exclude or not host:
            return False
        h = str(host).lower()
        return h in exclude or ('%s:%s' % (h, port)) in exclude

    def write(line):
        if st['fd'] == -1:
            name = 'net-%d-%d-py.jsonl' % (int(time.time() * 1000), os.getpid())
            st['fd'] = os.open(os.path.join(out_dir, name), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
            head = dumps({'t': 'proc', 'v': 1, 'pid': os.getpid(), 'lang': 'python',
                               'python': '%d.%d.%d' % sys.version_info[:3],
                               'script': os.path.basename(sys.argv[0])[:128] if sys.argv and sys.argv[0] else '(eval)',
                               'ts': int(time.time() * 1000)}) + '\n'
            os.write(st['fd'], head.encode())
            st['bytes'] += len(head)
        data = line.encode('utf-8', 'replace')
        os.write(st['fd'], data)
        st['bytes'] += len(data)

    def emit(rec):
        if st['disabled']:
            return
        if excluded(rec.get('host'), rec.get('port')):
            return
        rec['role'] = 'service' if st['service'] or time.monotonic() - t_start > service_after else 'script'
        rec['ts'] = int(time.time() * 1000)
        with lock:
            try:
                if st['records'] >= max_records or st['bytes'] >= max_bytes:
                    st['dropped'] += 1
                    if not st['marked']:
                        st['marked'] = True
                        write(dumps({'t': 'truncated', 'after': st['records'], 'ts': rec['ts']}) + '\n')
                    return
                write(dumps(rec) + '\n')
                st['records'] += 1
            except Exception:
                st['disabled'] = True  # unwritable dir: record nothing, silently

    def split_url(url):
        from urllib.parse import urlsplit
        u = urlsplit(url)
        path = u.path or '/'
        return {'scheme': u.scheme, 'host': u.hostname, 'port': u.port, 'path': path[:256],
                'pathLen': len(path), 'qLen': len(u.query)}

    def handle(event, args):
        if event == 'socket.getaddrinfo':
            host, port = args[0], args[1]
            if isinstance(host, bytes):
                host = host.decode('ascii', 'replace')
            tls.last_host = host
        elif event == 'socket.connect':
            addr = args[1]
            if isinstance(addr, tuple) and len(addr) >= 2:
                ip, port = addr[0], addr[1]
                name = getattr(tls, 'last_host', None)
                if loopback(ip) or loopback(name):
                    return
                emit({'t': 'connect', 'host': name or ip, 'ip': ip, 'port': port})
        elif event == 'urllib.Request':
            rec = split_url(args[0])
            if loopback(rec['host']):
                return
            rec.update({'t': 'url', 'method': args[3] or ('POST' if args[1] is not None else 'GET')})
            emit(rec)
        elif event == 'http.client.send':
            k = id(args[0])
            sent[k] = sent.get(k, 0) + len(args[1] or b'')
        elif event == 'socket.bind':
            a = args[1]
            if isinstance(a, tuple) and len(a) >= 2 and a[1]:
                st['service'] = True

    def hook(event, args):
        if event not in WATCH:  # hot path: called for every audit event (open, import, exec ...)
            return
        if test_throw == 'raw':
            raise RuntimeError('tap bug (test, raw)')
        try:
            if test_throw == 'guarded':
                raise RuntimeError('tap bug (test)')
            handle(event, args)
        except Exception:
            pass

    def at_exit():
        try:
            if st['fd'] != -1:
                if sent:
                    os.write(st['fd'], (dumps({'t': 'bytesOut', 'total': sum(sent.values())}) + '\n').encode())
                if st['dropped']:
                    os.write(st['fd'], (dumps({'t': 'summary', 'recorded': st['records'], 'dropped': st['dropped']}) + '\n').encode())
                os.close(st['fd'])
        except Exception:
            pass

    import atexit
    atexit.register(at_exit)
    sys.addaudithook(hook)


def _loghub_find_user_sitecustomize():
    # `site` imports only the FIRST sitecustomize on sys.path, and PYTHONPATH comes before
    # site-packages, so ours shadows the user's (venv / distro / corporate). Find the next one.
    import os
    import sys

    here = os.path.normcase(os.path.abspath(os.path.dirname(__file__)))
    rest = [p for p in sys.path if os.path.normcase(os.path.abspath(p or os.getcwd())) != here]
    # Cheap pre-check before importing importlib.util (~15 ms on Python 3.9): any sitecustomize
    # module, package or extension in the remaining directories?
    def has_candidate(d):
        try:
            return any(n == 'sitecustomize' or n.startswith('sitecustomize.') for n in os.listdir(d or '.'))
        except OSError:
            return False
    if not any(has_candidate(p) for p in rest if not p.lower().endswith('.zip')):
        return None
    import importlib.util
    from importlib.machinery import PathFinder
    spec = PathFinder.find_spec('sitecustomize', rest)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    sys.modules['sitecustomize'] = mod  # run it under its own name, as if imported directly
    return spec, mod


try:
    _loghub_install()
except Exception:
    pass
try:
    _loghub_user = _loghub_find_user_sitecustomize()
except Exception:
    _loghub_user = None
if _loghub_user is not None:
    # Outside our try: the user's own errors surface exactly as without the tap (site prints
    # "Error in sitecustomize" and continues).
    _loghub_user[0].loader.exec_module(_loghub_user[1])
