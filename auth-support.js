'use strict';
const { Pool } = require('pg');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function setupAuthSupport(app) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 48) throw new Error('SESSION_SECRET must contain at least 48 characters.');
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD_HASH) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD_HASH must be configured.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: true }, max: Math.min(5, Math.max(1, Number(process.env.DB_POOL_MAX || 3))), connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, query_timeout: 15000 });
  app.use(require('express').json({ limit: '32kb' }));
  // Trust only the configured number of ingress proxies; never use `true` on an unknown topology.
  const proxyRaw = process.env.TRUST_PROXY_HOPS;
  if (process.env.NODE_ENV === 'production' && (proxyRaw === undefined || proxyRaw === '')) throw new Error('Set TRUST_PROXY_HOPS to the verified number of trusted ingress proxies before production startup.');
  const proxyHops = proxyRaw === undefined || proxyRaw === '' ? 0 : Number(proxyRaw);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 3) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 3 and must match the hosting ingress topology.');
  app.set('trust proxy', proxyHops);
  app.use(session({ store: new PgSession({ pool, tableName: 'vidora_sessions', createTableIfMissing: true }), name: 'vidora.sid', secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, rolling: false, cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' } }));
  const authLimit = require('express-rate-limit')({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });
  const commentLimit = require('express-rate-limit')({ windowMs: 10 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
  const resetLimit = require('express-rate-limit')({ windowMs: 15 * 60 * 1000, limit: 3, standardHeaders: true, legacyHeaders: false });
  const readLimit = require('express-rate-limit')({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const user = (req,res,next) => req.session.account ? next() : res.status(401).json({error:'Please sign in.'});
  const admin = (req,res,next) => req.session.account?.role === 'admin' ? next() : res.status(403).json({error:'Admin access required.'});
  const origin = (req,res,next) => { const o=req.get('origin'); if(o){try{if(new URL(o).host!==req.get('host'))return res.status(403).json({error:'Origin rejected.'});}catch{return res.status(403).json({error:'Invalid origin.'});}} next(); };
  const setSession = (req,res,next,account,status=200) => req.session.regenerate(err=>{if(err)return next(err);req.session.account=account;req.session.save(e=>e?next(e):res.status(status).json({user:account}));});

  app.get('/api/auth/me',readLimit,(req,res)=>res.set('Cache-Control','no-store').json({user:req.session.account||null}));
  app.post('/api/auth/signup',authLimit,origin,async(req,res,next)=>{try{
    const name=String(req.body.name||'').trim().slice(0,60), email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||'');
    if(email===String(process.env.ADMIN_EMAIL).trim().toLowerCase())return res.status(403).json({error:'This address is reserved for the administrator.'});
    if(name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||password.length<10||password.length>72)return res.status(400).json({error:'Enter a valid name/email and a 10–72 character password.'});
    const hash=await bcrypt.hash(password,12);const q=await pool.query('INSERT INTO vidora_users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email',[name,email,hash]);
    setSession(req,res,next,{id:q.rows[0].id,name,email,role:'user'},201);
  }catch(e){if(e.code==='23505')return res.status(409).json({error:'An account with this email already exists.'});next(e);}});
  app.post('/api/auth/login',authLimit,origin,async(req,res,next)=>{try{
    const email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||'');
    if(email===String(process.env.ADMIN_EMAIL).trim().toLowerCase()){
      if(!(await bcrypt.compare(password,process.env.ADMIN_PASSWORD_HASH)))return res.status(401).json({error:'Email or password is incorrect.'});
      return setSession(req,res,next,{id:String(app.locals.adminAccount.id),name:'Vidora Admin',email,role:'admin'});
    }
    const q=await pool.query('SELECT id,name,email,password_hash FROM vidora_users WHERE email=$1',[email]);const r=q.rows[0];
    if(!r||!(await bcrypt.compare(password,r.password_hash)))return res.status(401).json({error:'Email or password is incorrect.'});
    setSession(req,res,next,{id:r.id,name:r.name,email:r.email,role:'user'});
  }catch(e){next(e);}});
  app.post('/api/auth/forgot-password',resetLimit,origin,async(req,res,next)=>{
    const generic='If the account exists and password-reset email is configured, a reset link will be sent.';
    try{
      const email=String(req.body.email||'').trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return res.json({ok:true,message:generic});
      if(email===String(process.env.ADMIN_EMAIL).trim().toLowerCase())return res.json({ok:true,message:generic});
      const q=await pool.query('SELECT id,email FROM vidora_users WHERE email=$1',[email]);
      if(!q.rowCount||!process.env.RESEND_API_KEY||!process.env.RESEND_FROM||!process.env.APP_BASE_URL)return res.json({ok:true,message:generic});
      const base=new URL(process.env.APP_BASE_URL);
      if(process.env.NODE_ENV==='production'&&base.protocol!=='https:')throw new Error('APP_BASE_URL must use HTTPS in production.');
      const token=crypto.randomBytes(32).toString('base64url'),tokenHash=crypto.createHash('sha256').update(token).digest('hex');
      await pool.query('DELETE FROM vidora_password_resets WHERE expires_at<NOW() OR used_at IS NOT NULL');
      await pool.query("INSERT INTO vidora_password_resets(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 minutes')",[q.rows[0].id,tokenHash]);
      const link=new URL('/',base);link.hash='reset='+encodeURIComponent(token);
      const sent=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.RESEND_FROM,to:[email],subject:'Reset your Vidora AI password',html:`<p>A password reset was requested for your Vidora AI account.</p><p><a href="${link.toString()}">Reset password</a></p><p>This link expires in 30 minutes. If you did not request it, ignore this email.</p>`}),signal:AbortSignal.timeout(15000)});
      if(!sent.ok){await pool.query('DELETE FROM vidora_password_resets WHERE token_hash=$1',[tokenHash]);console.error('[Vidora] Password reset email provider rejected the request:',sent.status);return res.json({ok:true,message:generic});}
      res.json({ok:true,message:generic});
    }catch(e){console.error('[Vidora] Password reset request failed:',e.message);res.json({ok:true,message:generic});}
  });
  app.post('/api/auth/reset-password',resetLimit,origin,async(req,res,next)=>{
    const token=String(req.body.token||''),password=String(req.body.password||'');
    if(!/^[A-Za-z0-9_-]{40,60}$/.test(token)||password.length<10||password.length>72)return res.status(400).json({error:'The reset link or new password is invalid.'});
    const tokenHash=crypto.createHash('sha256').update(token).digest('hex');let client;
    try{
      client=await pool.connect();await client.query('BEGIN');
      const q=await client.query('SELECT id,user_id FROM vidora_password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW() FOR UPDATE',[tokenHash]);
      if(!q.rowCount){await client.query('ROLLBACK');return res.status(400).json({error:'This password reset link is invalid or has expired.'});}
      const hash=await bcrypt.hash(password,12);
      await client.query('UPDATE vidora_users SET password_hash=$1 WHERE id=$2',[hash,q.rows[0].user_id]);
      await client.query('UPDATE vidora_password_resets SET used_at=NOW() WHERE id=$1',[q.rows[0].id]);
      const sessionTable=await client.query("SELECT to_regclass('vidora_sessions') AS table_name");
      if(sessionTable.rows[0]?.table_name)await client.query("DELETE FROM vidora_sessions WHERE sess->'account'->>'id'=$1",[String(q.rows[0].user_id)]);
      await client.query('COMMIT');
      req.session.destroy(()=>{});res.clearCookie('vidora.sid',{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production'});res.json({ok:true,message:'Password updated. Please sign in with your new password.'});
    }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});next(e);}finally{client?.release();}
  });
  app.post('/api/auth/logout',origin,(req,res,next)=>req.session.destroy(e=>{if(e)return next(e);res.clearCookie('vidora.sid',{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production'});res.json({ok:true});}));
  app.get('/api/community/public',readLimit,async(_req,res,next)=>{try{const q=await pool.query("SELECT c.id,c.body,c.kind,c.status,c.ai_reply,c.created_at,u.name FROM vidora_comments c JOIN vidora_users u ON u.id=c.user_id WHERE c.is_public=true AND c.kind IN ('feedback','suggestion') ORDER BY c.created_at DESC LIMIT 100");res.json({comments:q.rows});}catch(e){next(e);}});
  app.get('/api/community/mine',user,async(req,res,next)=>{try{const q=await pool.query('SELECT id,body,kind,status,priority,ai_reply,admin_note,created_at,updated_at FROM vidora_comments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',[req.session.account.id]);res.json({reports:q.rows});}catch(e){next(e);}});
  app.post('/api/community/comments',user,commentLimit,origin,async(req,res,next)=>{try{const body=String(req.body.body||'').trim(),kind=['feedback','bug','suggestion'].includes(req.body.kind)?req.body.kind:'feedback';if(body.length<3||body.length>2000)return res.status(400).json({error:'Comment must be 3–2,000 characters.'});const t=triage(body,kind);const q=await pool.query("INSERT INTO vidora_comments(user_id,body,kind,status,priority,ai_reply,ai_analysis,is_public) VALUES($1,$2,$3,'received',$4,$5,$6,$7) RETURNING id,status,ai_reply,created_at",[req.session.account.id,body,kind,t.priority,t.reply,t.analysis,['feedback','suggestion'].includes(kind)]);res.status(201).json({comment:q.rows[0],message:t.reply});}catch(e){next(e);}});
  app.get('/api/admin/issues',readLimit,user,admin,async(_req,res,next)=>{try{const q=await pool.query('SELECT c.id,c.body,c.kind,c.status,c.priority,c.ai_analysis,c.ai_reply,c.admin_note,c.is_public,c.created_at,u.name,u.email FROM vidora_comments c JOIN vidora_users u ON u.id=c.user_id ORDER BY c.created_at DESC LIMIT 200');res.json({issues:q.rows});}catch(e){next(e);}});
  app.patch('/api/admin/comments/:id/public',user,admin,origin,async(req,res,next)=>{try{const isPublic=req.body.isPublic===true;const found=await pool.query('SELECT kind FROM vidora_comments WHERE id=$1',[req.params.id]);if(!found.rowCount)return res.status(404).json({error:'Comment not found.'});if(isPublic&&!['feedback','suggestion'].includes(found.rows[0].kind))return res.status(400).json({error:'Bug reports and support requests cannot be published publicly.'});const q=await pool.query('UPDATE vidora_comments SET is_public=$1,updated_at=NOW() WHERE id=$2 RETURNING id,is_public,updated_at',[isPublic,req.params.id]);res.json({comment:q.rows[0]});}catch(e){next(e);}});
  app.delete('/api/admin/comments/:id',user,admin,origin,async(req,res,next)=>{try{const q=await pool.query('DELETE FROM vidora_comments WHERE id=$1 RETURNING id',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Comment not found.'});res.json({ok:true});}catch(e){next(e);}});
  app.patch('/api/admin/issues/:id',user,admin,origin,async(req,res,next)=>{try{const status=String(req.body.status||''),note=String(req.body.adminNote||'').trim().slice(0,1000);if(!['received','analyzing','in_progress','fixed'].includes(status))return res.status(400).json({error:'Invalid status.'});if(status==='fixed'&&req.body.verified!==true)return res.status(400).json({error:'To mark fixed, confirm that the approved fix is deployed and verified.'});const reply=statusText(status,note);const q=await pool.query('UPDATE vidora_comments SET status=$1,admin_note=$2,ai_reply=$3,updated_at=NOW() WHERE id=$4 RETURNING id,status,ai_reply,updated_at',[status,note,reply,req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Issue not found.'});res.json({issue:q.rows[0]});}catch(e){next(e);}});
  return pool.query(`CREATE TABLE IF NOT EXISTS vidora_users(id BIGSERIAL PRIMARY KEY,name VARCHAR(60) NOT NULL,email VARCHAR(254) NOT NULL UNIQUE,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS vidora_comments(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES vidora_users(id) ON DELETE CASCADE,body VARCHAR(2000) NOT NULL,kind VARCHAR(20) NOT NULL DEFAULT 'feedback',status VARCHAR(20) NOT NULL DEFAULT 'received',priority VARCHAR(10) NOT NULL DEFAULT 'normal',ai_reply TEXT NOT NULL,ai_analysis TEXT NOT NULL,admin_note TEXT,is_public BOOLEAN NOT NULL DEFAULT false,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS vidora_comments_created_idx ON vidora_comments(created_at DESC); CREATE INDEX IF NOT EXISTS vidora_comments_user_idx ON vidora_comments(user_id);
    CREATE TABLE IF NOT EXISTS vidora_password_resets(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES vidora_users(id) ON DELETE CASCADE,token_hash CHAR(64) NOT NULL UNIQUE,expires_at TIMESTAMPTZ NOT NULL,used_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()); CREATE INDEX IF NOT EXISTS vidora_password_resets_user_idx ON vidora_password_resets(user_id);`)
    .then(async()=>{
      const adminEmail=String(process.env.ADMIN_EMAIL).trim().toLowerCase();
      const adminRow=await pool.query('INSERT INTO vidora_users(name,email,password_hash) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash RETURNING id,name,email',['Vidora Admin',adminEmail,process.env.ADMIN_PASSWORD_HASH]);
      app.locals.adminAccount=adminRow.rows[0];app.locals.vidoraPool=pool;app.locals.requireUser=user;app.locals.requireAdmin=admin;
      console.log('[Vidora] Accounts/community database schema and admin account ready.');return pool;
    }).catch(e=>{pool.end().catch(()=>{});throw e;});
}
function triage(body,kind){const s=body.toLowerCase(),critical=/(data loss|account hacked|security breach|cannot access account)/.test(s),technical=/(error|bug|crash|failed|not working|stuck|upload|export|processing|503|500|429)/.test(s);return{priority:critical?'high':technical||kind==='bug'?'normal':'low',analysis:`Automatic initial triage: ${critical?'potential security/data-loss concern; urgent admin review':technical||kind==='bug'?'technical issue; request reproduction steps, device/browser and timestamp':kind==='suggestion'?'product suggestion':'general feedback'}. Preliminary classification only; not a confirmed root-cause diagnosis.`,reply:critical?'Your report was received and flagged for priority review. Do not share passwords or verification codes.':'Thanks. Your report was received and triaged. We will update its status after team review.'};}
function statusText(s,n){const m={received:'Your report has been received.',analyzing:'Your report is under review; we are investigating.',in_progress:'Your report is in progress; the team is working on it.',fixed:'The approved fix has been deployed and verified; this report is marked fixed.'};return m[s]+(n?' Team update: '+n:'');}
module.exports={setupAuthSupport};
