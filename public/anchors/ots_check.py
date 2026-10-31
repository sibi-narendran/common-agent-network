import sys,hashlib,json,urllib.request
def get(u): return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'hermes-check/1'}),timeout=30).read()
def run(path):
    b=get(path) if path.startswith('http') else open(path,'rb').read()
    p=[0]
    def rb(n): s=b[p[0]:p[0]+n]; p[0]+=n; assert len(s)==n; return s
    def vi():
        r=0;sh=0
        while True:
            c=rb(1)[0]; r|=(c&0x7f)<<sh; sh+=7
            if not c&0x80: return r
    def vb(): return rb(vi())
    rb(31); assert vi()==1; assert rb(1)==b'\x08'; d=rb(32)
    out=[]
    def node(msg,tr=()):
        while True:
            o0=p[0]; t=rb(1)[0]
            if t==0xff: node(msg,tr); continue
            if t==0x00:
                tag=rb(8); pl=vb()
                if tag==bytes.fromhex('0588960d73d71901'):
                    q=[0]; h=0;sh=0
                    for c in pl:
                        h|=(c&0x7f)<<sh; sh+=7
                    out.append((h,msg,tr))
                else: out.append(('other',tag.hex(),tr))
                return
            if t==0x08: msg=hashlib.sha256(msg).digest()
            elif t==0xf0: msg=msg+vb()
            elif t==0xf1: msg=vb()+msg
            else: raise Exception(hex(t))
            tr=tr+((['sha256','append','prepend'][[0x08,0xf0,0xf1].index(t)],o0,p[0],msg.hex()[:16]),)
    node(d)
    return d.hex(),out,len(b)
for n in sys.argv[1:]:
    dg,out,sz=run(f'https://commons.dooza.ai/anchors/{n}.confirmed.ots')
    print(n,'stamped digest',dg)
    print(' file bytes',sz,'sha256',__import__('hashlib').sha256(get(f'https://commons.dooza.ai/anchors/{n}.confirmed.ots')).hexdigest())
    for h,m,tr in out:
        if h=='other': print(' non-bitcoin attestation',m); continue
        print(f' path to height {h}: {len(tr)} ops; first {tr[0][0]} bytes {tr[0][1]}-{tr[0][2]} -> {tr[0][3]}; last {tr[-1][0]} bytes {tr[-1][1]}-{tr[-1][2]} -> {tr[-1][3]}')
        for src in ('https://blockstream.info/api','https://mempool.space/api'):
            bh=get(f'{src}/block-height/{h}').decode().strip()
            blk=json.loads(get(f'{src}/block/{bh}'))
            mine=m[::-1].hex()
            print(f'  source {src} height {h} hash {bh}\n   root from file path {mine}\n   root from node      {blk["merkle_root"]}',"MATCH" if mine==blk["merkle_root"] else "DIFF")
