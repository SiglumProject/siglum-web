import sys,os,json,re,hashlib,base64,types
from pathlib import Path,PosixPath
os.makedirs('/work',exist_ok=True);os.chdir('/work')
for p in Path('/wheels').glob('*.whl'):sys.path.insert(0,str(p))
from latexrestricted import PathSecurityError
class WorkPath(PosixPath):
 def __new__(cls,*args):
  p=Path(*args);p=p if p.is_absolute()else Path('/work')/p
  if not p.resolve().is_relative_to('/work'):raise PathSecurityError('Path outside tool workspace')
  return super().__new__(cls,str(p))
 def _guard(self):
  if not Path(str(self)).resolve().is_relative_to('/work'):raise PathSecurityError('Path outside tool workspace')
 def open(self,*args,**kwargs):
  self._guard();mode=args[0]if args else kwargs.get('mode','r')
  if any(c in mode for c in 'wax+')and not self.name.endswith('.minted'):raise PathSecurityError('Invalid tool output extension')
  return super().open(*args,**kwargs)
 def mkdir(self,*args,**kwargs):self._guard();return super().mkdir(*args,**kwargs)
 def unlink(self,*args,**kwargs):
  self._guard()
  if not self.name.endswith('.minted'):raise PathSecurityError('Invalid tool deletion')
  return super().unlink(*args,**kwargs)
 @classmethod
 def tex_roots(cls):return[cls('/work')]
 @classmethod
 def tex_openout_roots(cls):return[cls('/work')]
 @classmethod
 def tex_cwd(cls):return cls('/work')
def deny_lexer(*a,**k):raise ValueError('Custom Python lexers are not enabled')
restricted=types.ModuleType('latexminted.restricted');restricted.MintedTempRestrictedPath=WorkPath;restricted.load_custom_lexer=deny_lexer;restricted.latexminted_config=types.SimpleNamespace(config_error=None);sys.modules[restricted.__name__]=restricted
from latexminted.cmdline import ArgParser
from latexminted.messages import Messages
from latexminted.load_data import load_data
from latexminted.command_config import config
from latexminted.command_styledef import styledef
from latexminted import command_highlight
from latexminted.command_batch import batch
from latexminted.command_clean import clean,clean_config_temp,clean_temp_except_errlog
from pygments.lexers import get_all_lexers
builtin_lexers={alias for _,aliases,_,_ in get_all_lexers()for alias in aliases}
parser=ArgParser(prog='latexminted')
handlers={'config':config,'styledef':styledef,'highlight':command_highlight.highlight,'batch':batch,'clean':clean,'cleanconfig':clean_config_temp,'cleantemp':clean_temp_except_errlog}
for name,handler in handlers.items():parser.add_command(name,help=name,func=handler)
pending=None;supplied={}
def verified_input(*,messages,input_file,mdfivesum,encoding):
 if input_file not in supplied:raise ValueError('Undeclared project input: '+input_file)
 data=supplied[input_file]
 if hashlib.md5(data).hexdigest().upper()!=mdfivesum.upper():raise ValueError('Source digest mismatch')
 return data.decode(encoding)
command_highlight.load_input_file=verified_input
def prepare(raw):
 global pending
 req=json.loads(raw);argv=req['argv']
 if len(argv)>8 or any(not isinstance(x,str)or len(x)>1024 for x in argv):raise ValueError('Invalid tool arguments')
 args=parser.parse_args(argv)
 if args.debug:raise ValueError('Debug file moves are not enabled')
 if not re.fullmatch('[A-Fa-f0-9]{32}',args.md5)or not re.fullmatch('[0-9]{14}Z?',args.timestamp):raise ValueError('Invalid job identity or timestamp')
 name='_'+args.md5+'.data.minted'
 for item in req.get('controls',[]):
  if item['path']==name:
   text=item['text']
   if len(text)>1024*1024:raise ValueError('Control file exceeds limit')
   (WorkPath('/work')/name).write_text(text,encoding='utf8')
 messages=Messages(md5=args.md5)
 if args.subparser_name in ['cleanconfig','cleantemp']:data=None
 else:
  found=load_data(md5=args.md5,messages=messages,timestamp=args.timestamp,command=args.subparser_name)
  if found is None or messages.has_errors():raise ValueError(str(messages._errors))
  data,_=found
 jobs=data if isinstance(data,list)else[data]if isinstance(data,dict)else[]
 paths=[]
 for job in jobs:
  if job.get('command')=='highlight':
   options=job.get('pyopt',{})
   if options.get('lexer')not in builtin_lexers:raise ValueError('Only bundled Pygments lexers are enabled')
   if job.get('inputfilepath')and job['inputfilepath']not in paths:paths.append(job['inputfilepath'])
 pending=(args,messages,data)
 return json.dumps(paths)
def execute(raw):
 global supplied,pending
 supplied={x['path']:base64.b64decode(x['data'],validate=True)for x in json.loads(raw)}
 if sum(map(len,supplied.values()))>16*1024*1024:raise ValueError('Source input budget exceeded')
 before={p.relative_to('/work').as_posix():p.read_bytes()for p in Path('/work').rglob('*.minted')if p.is_file()}
 args,messages,data=pending;kw={'md5':args.md5,'timestamp':args.timestamp,'debug':False,'messages':messages,'data':data}
 if args.subparser_name in ['cleanconfig','cleantemp']:kw={'md5':args.md5}
 args.func(**kw)
 if messages.has_errors():raise ValueError(str(messages._errors))
 after={p.relative_to('/work').as_posix():p.read_bytes()for p in Path('/work').rglob('*.minted')if p.is_file()}
 files=[{'path':p,'data':base64.b64encode(b).decode()}for p,b in after.items()if before.get(p)!=b and not p.endswith('.data.minted')]
 removed=[p for p in before if p not in after and not p.endswith('.data.minted')]
 supplied={};pending=None
 return json.dumps({'files':files,'removed':removed,'log':'\n'.join(messages._warnings)})
