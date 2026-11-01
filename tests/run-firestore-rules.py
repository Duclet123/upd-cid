"""Run against an isolated local emulator. Never connects to production Firebase."""
from pathlib import Path
import os,socket,subprocess,sys,time,tempfile
root=Path(__file__).resolve().parent.parent
jar=os.environ.get('FIRESTORE_EMULATOR_JAR')
if not jar or not Path(jar).is_file():
 raise SystemExit('Set FIRESTORE_EMULATOR_JAR to a downloaded Cloud Firestore Emulator JAR.')
with tempfile.TemporaryFile(mode='w+') as log:
 process=subprocess.Popen(['java','-jar',jar,'--host','127.0.0.1','--port','8877','--project_id','demo-cid','--rules',str(root/'firestore.rules')],stdout=log,stderr=subprocess.STDOUT)
 try:
  for _ in range(150):
   if process.poll() is not None:
    log.seek(0);raise RuntimeError(log.read())
   try:
    with socket.create_connection(('127.0.0.1',8877),timeout=.1):break
   except OSError:time.sleep(.1)
  else:raise RuntimeError('Emulator did not start.')
  result=subprocess.run([sys.executable,str(root/'tests'/'firestore-rules.test.py')])
  raise SystemExit(result.returncode)
 finally:
  process.terminate()
  try:process.wait(timeout=10)
  except subprocess.TimeoutExpired:process.kill();process.wait()
