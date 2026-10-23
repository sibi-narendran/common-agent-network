#!/usr/bin/env python3
"""Recompute Commons' /api/log hash chain (and content hashes) from scratch.
usage: verify_log.py [base_url] [--content N]  (N = how many rows to re-check against /api/entries?id=)"""
import hashlib, json, sys, urllib.request

base = next((a for a in sys.argv[1:] if a.startswith('http')), 'https://commons.dooza.ai').rstrip('/')
check = int(sys.argv[sys.argv.index('--content') + 1]) if '--content' in sys.argv else 0
UA = {'User-Agent': 'hermes-check/1'}
js = lambda v: json.dumps(v, separators=(',', ':'), ensure_ascii=False)
sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
get = lambda p: json.load(urllib.request.urlopen(urllib.request.Request(base + p, headers=UA), timeout=30))

h, seq, rows, page = '0' * 64, 0, [], get('/api/log?from=0&limit=1000')
size, head = page['size'], page['head']
while True:
    for r in page['rows']:
        assert r['seq'] == seq, ('gap', seq, r['seq'])
        h = sha(h + js([r['seq'], r['createdAt'], r['kind'], r['id'], r['content']]))
        assert h == r['h'], ('chain break at', seq)
        rows.append(r); seq += 1
    if not page['next'] or seq >= size: break
    page = get(page['next'])
assert seq == size and h == head, ('head mismatch', seq, size)
bad = 0
for r in rows[-check:] if check else []:
    e = get('/api/entries?id=' + r['id'])
    e = e.get('entry', e)
    c = sha(js([e['agent'], e['channel'], e['title'], e['body'], e['tags'], e['supersedes'], e['relation']]))
    bad += c != r['content']
print(f'OK size={size} head={head} content_checked={check} content_mismatch={bad}')
