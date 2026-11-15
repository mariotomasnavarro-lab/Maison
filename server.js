// HUB LOCAL — tourne sur le PC de la maison. La recherche de recettes utilise Internet.
// Aucun paiement ; jusqu'à 4 utilisateurs. Les images restent dans la base locale.
import 'dotenv/config';
import express from 'express';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT doit être un nombre entre 1 et 65535.');
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
mkdirSync(DATA_DIR, { recursive: true });
const MAX_UTILISATEURS = 4;
const MAX_ADMINISTRATEURS = 2;
const db = new DatabaseSync(path.join(DATA_DIR, 'famille.db'));
db.exec('PRAGMA foreign_keys = ON');
process.on('unhandledRejection', e => console.error('[unhandledRejection] Promesse rejetée sans gestionnaire :', e));
process.on('uncaughtException', e => console.error('[uncaughtException] Exception non interceptée (processus conservé en vie) :', e));

db.exec(`
CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS familles(id INTEGER PRIMARY KEY, nom TEXT, intervalle_photos INTEGER DEFAULT 10, foyer_id TEXT, foyer_code TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS membres(id INTEGER PRIMARY KEY, famille_id INTEGER REFERENCES familles(id),
  nom TEXT, emoji TEXT DEFAULT '🙂', email TEXT UNIQUE, mdp TEXT, couleur TEXT, role TEXT DEFAULT 'membre', avatar_data TEXT,
  droits TEXT DEFAULT '{"agenda":true,"photos":false,"courses":true,"recettes":true,"taches":true}',
  supercoins INTEGER DEFAULT 0, UNIQUE(famille_id, couleur));
CREATE TABLE IF NOT EXISTS rendezvous(id INTEGER PRIMARY KEY, famille_id INTEGER, membre_id INTEGER, titre TEXT, emoji TEXT, debut TEXT, fin TEXT, lieu TEXT);
CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY, famille_id INTEGER, emoji TEXT, titre TEXT, legende TEXT, palette INTEGER DEFAULT 0, ajoute_par INTEGER, image_data TEXT);
CREATE TABLE IF NOT EXISTS courses(id INTEGER PRIMARY KEY, famille_id INTEGER, nom TEXT, ajoute_par INTEGER, assigne_a INTEGER, coins INTEGER DEFAULT 2, coins_verses INTEGER DEFAULT 0, achete_par INTEGER, achete_le TEXT);
CREATE TABLE IF NOT EXISTS recettes(id INTEGER PRIMARY KEY, famille_id INTEGER, titre TEXT, categorie TEXT, ingredients TEXT, etapes TEXT, emoji TEXT, duree TEXT);
CREATE TABLE IF NOT EXISTS favoris(membre_id INTEGER, recette_id INTEGER, PRIMARY KEY(membre_id, recette_id));
CREATE TABLE IF NOT EXISTS taches(id INTEGER PRIMARY KEY, famille_id INTEGER, titre TEXT, cree_par INTEGER, assigne_a INTEGER, coins INTEGER DEFAULT 5, statut TEXT DEFAULT 'en_attente_validation', fait_le TEXT, date_prevue TEXT);
CREATE TABLE IF NOT EXISTS coins_historique(id INTEGER PRIMARY KEY, membre_id INTEGER, montant INTEGER, motif TEXT, date TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS recompenses(id INTEGER PRIMARY KEY, famille_id INTEGER, membre_id INTEGER, libelle TEXT, seuil INTEGER, obtenue INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS recompenses_foyer(famille_id INTEGER NOT NULL, mois TEXT NOT NULL, libelle TEXT NOT NULL DEFAULT '', PRIMARY KEY(famille_id,mois));
CREATE TABLE IF NOT EXISTS family_rewards(id INTEGER PRIMARY KEY, famille_id INTEGER NOT NULL, titre TEXT NOT NULL, cout INTEGER NOT NULL DEFAULT 0, membres TEXT NOT NULL DEFAULT '[]', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS invitations(id INTEGER PRIMARY KEY, famille_id INTEGER, code TEXT UNIQUE, nom TEXT, expire_le INTEGER, statut TEXT DEFAULT 'active', email TEXT, role TEXT DEFAULT 'member');
`);
for (const [table, column] of [['familles','foyer_id'], ['familles','foyer_code'], ['membres', 'avatar_data'], ['photos', 'image_data'], ['invitations','email'], ['invitations','role'], ['taches','date_prevue']]) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
}

db.exec(`CREATE TABLE IF NOT EXISTS albums(id INTEGER PRIMARY KEY, famille_id INTEGER NOT NULL, nom TEXT NOT NULL, cree_par INTEGER NOT NULL, UNIQUE(famille_id,nom));
CREATE TABLE IF NOT EXISTS pantry(id INTEGER PRIMARY KEY, famille_id INTEGER NOT NULL, nom TEXT NOT NULL, statut TEXT NOT NULL DEFAULT 'stock', UNIQUE(famille_id,nom));
CREATE TABLE IF NOT EXISTS recipe_favorites(famille_id INTEGER NOT NULL, membre_id INTEGER NOT NULL, source TEXT NOT NULL, recette_id TEXT NOT NULL, titre TEXT NOT NULL, donnees TEXT NOT NULL, PRIMARY KEY(membre_id,source,recette_id));
`);
// Chaque famille existante reçoit ses identifiants sans toucher aux données déjà stockées.
const FOYER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normalizeFoyerCode = value => String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
function nouveauCodeFoyer(){ let code; do { code=Array.from(randomBytes(8),b=>FOYER_ALPHABET[b%FOYER_ALPHABET.length]).join(''); } while(db.prepare('SELECT 1 FROM familles WHERE foyer_code=?').get(code)); return code; }
for (const f of db.prepare('SELECT id,foyer_id,foyer_code FROM familles').all()) {
  const foyerId=f.foyer_id||randomBytes(24).toString('hex');
  let foyerCode=normalizeFoyerCode(f.foyer_code);
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(foyerCode)) foyerCode=nouveauCodeFoyer();
  else if (foyerCode!==f.foyer_code && db.prepare('SELECT 1 FROM familles WHERE foyer_code=? AND id<>?').get(foyerCode,f.id)) foyerCode=nouveauCodeFoyer();
  if (foyerId!==f.foyer_id || foyerCode!==f.foyer_code) db.prepare('UPDATE familles SET foyer_id=?,foyer_code=? WHERE id=?').run(foyerId,foyerCode,f.id);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_familles_foyer_code ON familles(foyer_code)');
const albumCols = db.prepare('PRAGMA table_info(photos)').all().map(row => row.name);
if (!albumCols.includes('album_id')) db.exec('ALTER TABLE photos ADD COLUMN album_id INTEGER');
const existingFamilies = db.prepare('SELECT id FROM familles').all();
for (const family of existingFamilies) {
  const owner = db.prepare("SELECT id FROM membres WHERE famille_id=? AND role='admin' ORDER BY id LIMIT 1").get(family.id);
  if (!owner) continue;
  db.prepare("INSERT OR IGNORE INTO albums(famille_id,nom,cree_par) VALUES(?, 'Album famille', ?)").run(family.id, owner.id);
  const album = db.prepare("SELECT id FROM albums WHERE famille_id=? AND nom='Album famille'").get(family.id);
  db.prepare('UPDATE photos SET album_id=? WHERE famille_id=? AND album_id IS NULL').run(album.id, family.id);
}
db.exec(`INSERT OR IGNORE INTO pantry(famille_id,nom,statut)
SELECT famille_id, lower(trim(nom)), CASE WHEN achete_par IS NULL THEN 'needed' ELSE 'stock' END FROM courses WHERE trim(nom)<>'';`);
const cfg = process.env.SESSION_SECRET || db.prepare("SELECT v FROM config WHERE k='secret'").get()?.v || (s => (db.prepare("INSERT INTO config VALUES('secret',?)").run(s), s))(randomBytes(32).toString('hex'));
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET doit être défini en production.');

const fam = id => db.prepare('SELECT * FROM familles WHERE id=?').get(id);
const pendantes = fid => db.prepare("SELECT COUNT(*) n FROM invitations WHERE famille_id=? AND statut='active' AND expire_le>?").get(fid, Date.now()).n;
const utilisateurs = fid => db.prepare('SELECT COUNT(*) n FROM membres WHERE famille_id=?').get(fid).n + pendantes(fid);

const baseUrl = () => (process.env.APP_URL || 'http://localhost:'+PORT).replace(/\/+$/, '');
const requestBaseUrl = req => process.env.APP_URL ? baseUrl() : `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
const invitationUrl = (code, base = baseUrl()) => `${base}/?code=${encodeURIComponent(code)}`;
const app = express();
app.disable('x-powered-by');
const helmet = (await import('helmet')).default;
const { rateLimit } = await import('express-rate-limit');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use((req,res,next)=>{res.setHeader('Permissions-Policy','fullscreen=(self)');next()});
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { erreur: 'Trop de tentatives. Réessayez dans 15 minutes.' } });
app.use('/api/connexion', loginLimit);
const foyerCodeAttempts=new Map();
const foyerCodeLimit=(req,res,next)=>{const key=req.ip||req.socket.remoteAddress||'unknown', now=Date.now(), old=foyerCodeAttempts.get(key)||[]; const recent=old.filter(t=>now-t<15*60*1000); if(recent.length>=10)return res.status(429).json({erreur:'Trop de tentatives de code foyer. Réessayez dans 15 minutes.'});recent.push(now);foyerCodeAttempts.set(key,recent);next();};
app.use('/api/admin/connexion', loginLimit);
app.use(express.json({ limit: '32mb' }));
// Les assets peuvent être à la racine ou dans public/ selon le mode de déploiement.
const appFile = name => {
  const publicFile = path.join(ROOT_DIR, 'public', name);
  return existsSync(publicFile) ? publicFile : path.join(ROOT_DIR, name);
};
const sendAppFile=(name,type)=>app.get('/'+name,(req,res)=>res.type(type).sendFile(appFile(name)));
sendAppFile('client.js','application/javascript');
sendAppFile('sw.js','application/javascript');
sendAppFile('manifest.webmanifest','application/manifest+json');
sendAppFile('icon-192.png','image/png');
sendAppFile('icon-512.png','image/png');
app.get('/', (req,res)=>res.sendFile(appFile('index.html')));
app.get('/api', (req, res) => res.json({ ok: true, application: 'Maison Mosaïque', mode: 'hébergé' }));
app.get('/api/qr', async (req,res) => { const text=String(req.query.text||''); if(!text||text.length>2048)return res.status(400).json({erreur:'Le texte QR est requis (maximum 2 048 caractères).'}); try { const svg=await QRCode.toString(text,{type:'svg',errorCorrectionLevel:'M',margin:2,width:280}); res.type('image/svg+xml').set('Cache-Control','no-store').send(svg); } catch(e) { console.error('QR generation:',e.message); res.status(500).json({erreur:'Impossible de générer le QR code.'}); } });
app.get('/api/health', (req, res) => res.json({ ok: true }));

const sign = (id, fid) => jwt.sign({ id, famille: fid, foyerId: String(fam(fid)?.foyer_id || '') }, cfg, { expiresIn: '90d' });
const auth = (req, res, next) => {
  try { const claims=jwt.verify((req.headers.authorization || '').slice(7), cfg); req.m = db.prepare('SELECT * FROM membres WHERE id=? AND famille_id=?').get(claims.id, claims.famille); if(!req.m || String(fam(req.m.famille_id)?.foyer_id||'')!==String(claims.foyerId||'')) req.m=null; } catch {}
  if (!req.m) return res.status(401).json({ erreur: 'Non authentifié' });
  next();
};
const admin = (req, res, next) => req.m.role === 'admin' ? next() : res.status(403).json({ erreur: 'Réservé aux administrateurs' });
const droit = d => (req, res, next) => req.m.role === 'admin' || JSON.parse(req.m.droits)[d] ? next() : res.status(403).json({ erreur: `Droit « ${d} » manquant` });
const coins = (membre, montant, motif) => {
  db.prepare('UPDATE membres SET supercoins=supercoins+? WHERE id=?').run(montant, membre);
  db.prepare('INSERT INTO coins_historique(membre_id,montant,motif) VALUES(?,?,?)').run(membre, montant, motif);
  db.prepare('UPDATE recompenses SET obtenue=1 WHERE membre_id=? AND obtenue=0 AND seuil<=(SELECT supercoins FROM membres WHERE id=?)').run(membre, membre);
};
const HEX = /^#[0-9a-fA-F]{6}$/;
const RECETTES = [['Pâtes du soleil','🍝','plat',['Pâtes complètes','Tomates cerises','Basilic'],'20 min'],['Bol croquant','🥗','entrée',['Pommes','Carottes','Noix'],'15 min'],['Gratin tout doux','🥘','plat',['Pommes de terre','Lait','Fromage'],'45 min'],['Tartines du marché','🥑','apéritif',['Pain','Tomates cerises','Avocat'],'10 min'],['Compote maison','🍎','dessert',['Pommes','Cannelle'],'25 min'],['Mousse au chocolat','🍫','dessert',['Chocolat','Oeufs','Sucre'],'30 min'],['Velouté de potiron','🎃','entrée',['Potiron','Crème','Oignon'],'35 min'],['Dips et crudités','🥕','apéritif',['Carottes','Concombre','Yaourt'],'10 min']];
const PALETTES = [['#779b7a','#d9bf84'],['#dc9b82','#eccb78'],['#6da1ad','#d7bd86'],['#a26c55','#dbb66b'],['#c2b7d8','#f4d9a8'],['#dfa6a0','#f2c762']];

// --- Inscription ---
app.post('/api/inscription', (req, res) => {
  const { famille, nom, emoji = '🙂', email, mdp, couleur } = req.body;
  if (!famille || !nom || !email || (mdp || '').length < 8 || !HEX.test(couleur || '')) return res.status(400).json({ erreur: 'Champs invalides (mot de passe : 8 caractères minimum)' });
  try {
    const foyerId=randomBytes(24).toString('hex'), foyerCode=nouveauCodeFoyer();
    const fid = db.prepare('INSERT INTO familles(nom,foyer_id,foyer_code) VALUES(?,?,?)').run(String(famille).trim(),foyerId,foyerCode).lastInsertRowid;
    const mid = db.prepare('INSERT INTO membres(famille_id,nom,emoji,email,mdp,couleur,role) VALUES(?,?,?,?,?,?,?)').run(fid, nom, emoji, email, bcrypt.hashSync(mdp, 10), couleur.toLowerCase(), 'admin').lastInsertRowid;
    db.prepare('INSERT OR IGNORE INTO albums(famille_id,nom,cree_par) VALUES(?,?,?)').run(fid, 'Album famille', mid);
    res.status(201).json({ token: sign(mid, fid), foyerCode });
  } catch { res.status(409).json({ erreur: 'E-mail déjà utilisé' }); }
});
app.get('/api/profils', foyerCodeLimit, (req,res) => {
  const queryCodes=req.query.foyer==null?null:(Array.isArray(req.query.foyer)?req.query.foyer:[req.query.foyer]).map(normalizeFoyerCode);
  const code=queryCodes?(queryCodes.every(value=>value===queryCodes[0])?queryCodes[0]:''):normalizeFoyerCode(req.get('X-Foyer-Code')||'');
  if(!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code)) return res.status(400).json({erreur:'Saisissez un code de foyer valide.'});
  const f=db.prepare('SELECT id,nom FROM familles WHERE foyer_code=?').get(code);
  if(!f) return res.status(404).json({erreur:'Code de foyer inconnu.'});
  const members=db.prepare('SELECT id,nom,emoji,couleur,avatar_data,role FROM membres WHERE famille_id=? ORDER BY id').all(f.id).map(m=>({id:String(m.id),name:m.nom,emoji:m.emoji,color:m.couleur,avatar:m.avatar_data||null,role:m.role==='admin'?'admin':'member'}));
  res.set('Cache-Control','no-store').json({familyName:f.nom,members});
});

app.post('/api/connexion/profil', (req,res) => {
  const id=Number(req.body?.memberId), foyer=db.prepare('SELECT id FROM familles WHERE foyer_code=?').get(normalizeFoyerCode(req.body?.foyer));
  if(!foyer)return res.status(404).json({erreur:'Code de foyer invalide.'});
  if(!Number.isSafeInteger(id)||id<1) return res.status(400).json({erreur:'Sélectionnez un profil valide.'});
  const m=db.prepare("SELECT id,famille_id,role FROM membres WHERE id=? AND famille_id=? AND role<>'admin'").get(id,foyer.id);
  if(!m) return res.status(404).json({erreur:'Ce profil simple est introuvable. Actualisez la liste des profils.'});
  res.set('Cache-Control','no-store').json({token:sign(m.id,m.famille_id),memberId:String(m.id),foyerCode:fam(m.famille_id).foyer_code});
});

app.post('/api/connexion', (req, res) => {
  const foyer=db.prepare('SELECT id FROM familles WHERE foyer_code=?').get(normalizeFoyerCode(req.body?.foyer));
  if(!foyer)return res.status(404).json({erreur:'Code de foyer invalide.'});
  const m = db.prepare('SELECT * FROM membres WHERE email=? AND famille_id=?').get(req.body.email || '',foyer.id);
  if (!m || !bcrypt.compareSync(req.body.mdp || '', m.mdp)) return res.status(401).json({ erreur: 'Identifiants incorrects' });
  res.set('Cache-Control','no-store').json({ token: sign(m.id, m.famille_id), foyerCode: fam(m.famille_id).foyer_code });
});

app.post('/api/admin/definir-mot-de-passe', auth, admin, (req,res) => { const mdp=String(req.body?.mdp||''); if(mdp.length<8) return res.status(400).json({erreur:'Le mot de passe doit contenir au moins 8 caractères.'}); if(req.m.mdp) return res.status(409).json({erreur:'Ce compte possède déjà un mot de passe. Reconnectez-vous pour le modifier.'}); db.prepare('UPDATE membres SET mdp=? WHERE id=? AND famille_id=?').run(bcrypt.hashSync(mdp,10),req.m.id,req.m.famille_id); res.json({ok:true}); });

app.post('/api/admin/switch', auth, admin, (req,res) => {
  const target=db.prepare('SELECT id,famille_id FROM membres WHERE id=? AND famille_id=?').get(Number(req.body?.memberId),req.m.famille_id);
  if(!target) return res.status(404).json({erreur:'Profil introuvable dans votre famille.'});
  res.set('Cache-Control','no-store').json({token:sign(target.id,target.famille_id),memberId:String(target.id),foyerCode:fam(target.famille_id).foyer_code});
});

app.post('/api/admin/recuperer-foyer', loginLimit, (req,res)=>{const email=String(req.body?.email||'').trim().toLowerCase(),mdp=String(req.body?.mdp||'');const rows=db.prepare("SELECT * FROM membres WHERE lower(email)=? AND role='admin'").all(email);const m=rows.find(x=>x.mdp&&bcrypt.compareSync(mdp,x.mdp));if(!m)return res.status(401).json({erreur:'Identifiants administrateur incorrects.'});res.set('Cache-Control','no-store').json({token:sign(m.id,m.famille_id),foyerCode:fam(m.famille_id).foyer_code});});
app.post('/api/admin/connexion', (req, res) => {
  const foyer=db.prepare('SELECT id FROM familles WHERE foyer_code=?').get(normalizeFoyerCode(req.body?.foyer));
  if(!foyer)return res.status(404).json({erreur:'Code de foyer invalide.'});
  const m=db.prepare("SELECT * FROM membres WHERE id=? AND famille_id=? AND role='admin'").get(Number(req.body.memberId),foyer.id);
  if(!m || !bcrypt.compareSync(req.body.mdp||'',m.mdp)) return res.status(401).json({erreur:'Mot de passe incorrect.'});
  res.set('Cache-Control','no-store').json({token:sign(m.id,m.famille_id),foyerCode:fam(m.famille_id).foyer_code});
});

// --- Membres, couleurs uniques, droits ---
app.delete('/api/membres/:id', auth, admin, (req, res) => {
  const m = db.prepare('SELECT * FROM membres WHERE id=? AND famille_id=?').get(req.params.id, req.m.famille_id);
  if (!m || m.role === 'admin') return res.status(400).json({ erreur: 'Suppression impossible' });
  db.prepare('DELETE FROM membres WHERE id=? AND famille_id=?').run(m.id,req.m.famille_id); res.status(204).end();
});
const MAX_AVATAR_DATA_URL = 8 * 1024 * 1024; // env. 6 Mio d’image binaire après encodage base64
app.patch('/api/membres/:id/avatar', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ erreur: 'Profil introuvable.' });
  const cible = db.prepare('SELECT id FROM membres WHERE id=? AND famille_id=?').get(id, req.m.famille_id);
  if (!cible) return res.status(404).json({ erreur: 'Profil introuvable dans votre famille.' });
  if (req.m.role !== 'admin' && Number(req.m.id) !== id) return res.status(403).json({ erreur: 'Vous pouvez uniquement modifier votre propre photo.' });
  const avatar_data = req.body?.avatar_data;
  if (typeof avatar_data !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar_data))
    return res.status(400).json({ erreur: 'Format de photo invalide. Choisissez une image JPEG, PNG ou WebP.' });
  if (avatar_data.length > MAX_AVATAR_DATA_URL)
    return res.status(413).json({ erreur: 'Cette photo est trop volumineuse. Choisissez une image plus petite (maximum 6 Mo environ).' });
  db.prepare('UPDATE membres SET avatar_data=? WHERE id=? AND famille_id=?').run(avatar_data, id, req.m.famille_id);
  res.json({ ok: true });
});
app.patch('/api/membres/:id/droits', auth, admin, (req, res) => {
  const cible = db.prepare('SELECT * FROM membres WHERE id=? AND famille_id=?').get(req.params.id, req.m.famille_id);
  if (!cible) return res.sendStatus(404);
  if (req.body.role === 'admin' && cible.role !== 'admin' && db.prepare("SELECT COUNT(*) n FROM membres WHERE famille_id=? AND role='admin'").get(req.m.famille_id).n >= 2)
    return res.status(400).json({ erreur: 'Maximum deux administrateurs' });
  if (req.body.droits) db.prepare('UPDATE membres SET droits=? WHERE id=? AND famille_id=?').run(JSON.stringify(req.body.droits), cible.id,req.m.famille_id);
  if (req.body.role) db.prepare('UPDATE membres SET role=? WHERE id=? AND famille_id=?').run(req.body.role === 'admin' ? 'admin' : 'membre', cible.id,req.m.famille_id);
  res.json({ ok: true });
});

// --- Invitations (valables 24 h) ---
app.post('/api/invitations', auth, admin, async (req, res) => {
  const fid=req.m.famille_id, besoin=utilisateurs(fid)+1, nom=String(req.body.nom||'').trim(), email=String(req.body.email||'').trim(), role=req.body.role==='admin'?'admin':'member';
  if (!nom) return res.status(400).json({erreur:'Indiquez le nom du membre.'});
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({erreur:'Adresse e-mail invalide.'});
  if (besoin>MAX_UTILISATEURS) return res.status(403).json({erreur:'La famille peut compter au maximum '+MAX_UTILISATEURS+' personnes, invitations comprises.'});
  const admins=db.prepare("SELECT COUNT(*) n FROM membres WHERE famille_id=? AND role='admin'").get(fid).n;
  const pendingAdmins=db.prepare("SELECT COUNT(*) n FROM invitations WHERE famille_id=? AND statut='active' AND expire_le>? AND role='admin'").get(fid,Date.now()).n;
  if (role==='admin' && admins+pendingAdmins>=2) return res.status(403).json({erreur:'Maximum deux administrateurs, invitations en attente comprises.'});
  const code=randomBytes(4).toString('hex').toUpperCase(), expire=Date.now()+864e5, url=invitationUrl(code,requestBaseUrl(req));
  const qrData=await QRCode.toDataURL(url,{errorCorrectionLevel:'M',margin:1,width:280});
  const id=db.prepare('INSERT INTO invitations(famille_id,code,nom,expire_le,email,role) VALUES(?,?,?,?,?,?)').run(fid,code,nom,expire,email||null,role).lastInsertRowid;
  res.status(201).json({id:String(id),code,expire_le:expire,role,url,qrData,emailMessage: email ? 'Aucun courriel n’est envoyé par l’application : partagez le lien ou le QR code.' : 'Aucune adresse e-mail fournie.'});
});
app.delete('/api/invitations/:id', auth, admin, (req, res) => {
  db.prepare("UPDATE invitations SET statut='annulee' WHERE id=? AND famille_id=?").run(req.params.id, req.m.famille_id); res.sendStatus(204);
});
const invitationValide = c => db.prepare("SELECT * FROM invitations WHERE code=? AND statut='active' AND expire_le>?").get(c || '', Date.now());
app.get('/api/invitation/:code', (req, res) => {
  const i = invitationValide(req.params.code);
  if (!i) return res.status(404).json({ erreur: 'Invitation invalide ou expirée' });
  res.json({ nom: i.nom, famille: fam(i.famille_id).nom, role: i.role || 'member', couleurs_prises: db.prepare('SELECT couleur FROM membres WHERE famille_id=?').all(i.famille_id).map(x => x.couleur) });
});
app.post('/api/rejoindre', (req, res) => {   // se passe en local : aucun accès Internet requis
  const { code, nom, emoji = '🙂', email, mdp, couleur } = req.body, i = invitationValide(code);
  const role=(i?.role||'member')==='admin'?'admin':'member', mail=String(email||'').trim().toLowerCase();
  if (!i) return res.status(404).json({ erreur: 'Invitation invalide ou expirée' });
  if (!HEX.test(couleur || '')) return res.status(400).json({ erreur: 'Choisissez une couleur valide.' });
  if (role==='admin' && (!/^\S+@\S+\.\S+$/.test(mail) || (mdp||'').length<8)) return res.status(400).json({erreur:'Pour un administrateur, indiquez une adresse e-mail et un mot de passe de 8 caractères minimum.'});
  if (role==='admin' && i.email && mail !== i.email.toLowerCase()) return res.status(403).json({ erreur: 'Utilisez l’adresse e-mail qui a reçu cette invitation.' });
  if (db.prepare('SELECT COUNT(*) n FROM membres WHERE famille_id=?').get(i.famille_id).n >= MAX_UTILISATEURS) return res.status(403).json({ erreur: 'Cette famille a atteint 4 utilisateurs.' });
  if ((i.role||'member')==='admin' && db.prepare("SELECT COUNT(*) n FROM membres WHERE famille_id=? AND role='admin'").get(i.famille_id).n>=2) return res.status(403).json({erreur:'Cette famille compte déjà deux administrateurs.'});
  try {
    const id = db.prepare('INSERT INTO membres(famille_id,nom,emoji,email,mdp,couleur,role) VALUES(?,?,?,?,?,?,?)').run(i.famille_id, nom || i.nom, emoji, role==='admin'?mail:null, role==='admin'?bcrypt.hashSync(mdp, 10):null, couleur.toLowerCase(), role==='admin'?'admin':'membre').lastInsertRowid;
    db.prepare("UPDATE invitations SET statut='utilisee' WHERE id=?").run(i.id);
    res.status(201).json({ token: sign(id, i.famille_id), foyerCode: fam(i.famille_id).foyer_code });
  } catch (e) { res.status(409).json({ erreur: String(e.message).includes('couleur') ? 'Cette couleur est déjà prise par un autre membre' : 'E-mail déjà utilisé' }); }
});

// --- Agenda ---
const agendaInput = (body, fid, defaultMemberId) => {
  const titre = String(body?.titre || '').trim().slice(0, 160);
  const debut = typeof body?.debut === 'string' ? body.debut : '';
  const membre_id = Number(body?.membre_id ?? defaultMemberId);
  if (!titre) return { erreur: 'Indiquez le nom du rendez-vous.' };
  if (!debut || !Number.isFinite(Date.parse(debut))) return { erreur: 'Indiquez une date et une heure valides.' };
  if (!Number.isSafeInteger(membre_id) || !db.prepare('SELECT 1 FROM membres WHERE id=? AND famille_id=?').get(membre_id, fid)) return { erreur: 'Membre hors du foyer.' };
  const fin = typeof body?.fin === 'string' && Number.isFinite(Date.parse(body.fin)) ? body.fin : debut;
  return { titre, debut, fin, membre_id, emoji: String(body?.emoji || '📅').slice(0, 8), lieu: String(body?.lieu || '').trim().slice(0, 160) };
};
app.post('/api/agenda', auth, droit('agenda'), (req, res) => {
  const e = agendaInput(req.body, req.m.famille_id, req.m.id);
  if (e.erreur) return res.status(400).json({ erreur: e.erreur });
  res.status(201).json({ id: db.prepare('INSERT INTO rendezvous(famille_id,membre_id,titre,emoji,debut,fin,lieu) VALUES(?,?,?,?,?,?,?)').run(req.m.famille_id, e.membre_id, e.titre, e.emoji, e.debut, e.fin, e.lieu).lastInsertRowid });
});
app.patch('/api/agenda/:id', auth, droit('agenda'), (req, res) => {
  const e = agendaInput(req.body, req.m.famille_id, req.m.id);
  if (e.erreur) return res.status(400).json({ erreur: e.erreur });
  const result = db.prepare('UPDATE rendezvous SET titre=?,emoji=?,debut=?,fin=?,lieu=?,membre_id=? WHERE id=? AND famille_id=?').run(e.titre, e.emoji, e.debut, e.fin, e.lieu, e.membre_id, req.params.id, req.m.famille_id);
  if (!result.changes) return res.status(404).json({ erreur: 'Rendez-vous introuvable dans votre foyer.' });
  res.json({ ok: true });
});
app.delete('/api/agenda/:id', auth, droit('agenda'), (req, res) => { db.prepare('DELETE FROM rendezvous WHERE id=? AND famille_id=?').run(req.params.id, req.m.famille_id); res.status(204).end(); });

// --- Photos (souvenirs en emoji) ---
app.post('/api/photos', auth, (req, res) => {
  const batch = Array.isArray(req.body?.photos) ? req.body.photos : [req.body || {}];
  if (!batch.length || batch.length > 15) return res.status(400).json({ erreur: 'Ajoutez de 1 à 15 photos à la fois.' });
  const album_id = req.body?.album_id ?? batch[0]?.album_id;
  const album = db.prepare('SELECT * FROM albums WHERE id=? AND famille_id=?').get(Number(album_id), req.m.famille_id);
  if (!album) return res.status(400).json({ erreur: 'Choisissez un album valide.' });
  if (req.m.role !== 'admin' && album.cree_par !== req.m.id) return res.status(403).json({ erreur: 'Seule la personne qui gère cet album peut y ajouter des photos.' });
  const valid = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
  for (const p of batch) if (p.image_data != null && (!valid.test(p.image_data) || p.image_data.length > 1800000)) return res.status(400).json({ erreur: 'Une image est invalide ou trop lourde. Choisissez des images plus petites.' });
  const insert = db.prepare('INSERT INTO photos(famille_id,emoji,titre,legende,palette,ajoute_par,image_data,album_id) VALUES(?,?,?,?,?,?,?,?)');
  try { db.exec('BEGIN'); batch.forEach(p => insert.run(req.m.famille_id, String(p.emoji || '📷'), String(p.titre || 'Souvenir').slice(0,60), String(p.legende || '').slice(0,120), Number(p.palette) || 0, req.m.id, p.image_data ?? null, album.id)); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  res.status(201).json({ added: batch.length });
});
app.post('/api/albums', auth, (req, res) => {
  const nom = String(req.body.nom || '').trim().slice(0, 50);
  if (!nom) return res.status(400).json({ erreur: 'Donnez un nom à cet album.' });
  try {
    const id = db.prepare('INSERT INTO albums(famille_id,nom,cree_par) VALUES(?,?,?)').run(req.m.famille_id, nom, req.m.id).lastInsertRowid;
    res.status(201).json({ id: S(id), name: nom, ownerId: S(req.m.id) });
  } catch { res.status(409).json({ erreur: 'Un album porte déjà ce nom.' }); }
});
app.patch('/api/albums/:id', auth, (req, res) => {
  const album = db.prepare('SELECT * FROM albums WHERE id=? AND famille_id=?').get(req.params.id, req.m.famille_id);
  if (!album) return res.sendStatus(404);
  if (req.m.role !== 'admin' && album.cree_par !== req.m.id) return res.status(403).json({ erreur: 'Seule la personne qui a créé cet album peut le modifier.' });
  const nom = String(req.body.nom || '').trim().slice(0, 50);
  if (!nom) return res.status(400).json({ erreur: 'Donnez un nom à cet album.' });
  try { db.prepare('UPDATE albums SET nom=? WHERE id=? AND famille_id=?').run(nom, album.id,req.m.famille_id); res.json({ ok: true }); }
  catch { res.status(409).json({ erreur: 'Un album porte déjà ce nom.' }); }
});
app.delete('/api/albums/:id', auth, (req, res) => {
  const album = db.prepare('SELECT * FROM albums WHERE id=? AND famille_id=?').get(req.params.id, req.m.famille_id);
  if (!album) return res.sendStatus(404);
  if (req.m.role !== 'admin' && album.cree_par !== req.m.id) return res.status(403).json({ erreur: 'Seule la personne qui a créé cet album peut le supprimer.' });
  if (db.prepare('SELECT COUNT(*) n FROM albums WHERE famille_id=?').get(req.m.famille_id).n <= 1) return res.status(400).json({ erreur: 'Gardez au moins un album.' });
  db.prepare('DELETE FROM photos WHERE album_id=? AND famille_id=?').run(album.id,req.m.famille_id);
  db.prepare('DELETE FROM albums WHERE id=? AND famille_id=?').run(album.id,req.m.famille_id);
  res.sendStatus(204);
});

app.delete('/api/photos/:id', auth, (req, res) => {
  const photo = db.prepare('SELECT p.id, a.cree_par FROM photos p JOIN albums a ON a.id=p.album_id WHERE p.id=? AND p.famille_id=?').get(req.params.id, req.m.famille_id);
  if (!photo) return res.sendStatus(404);
  if (req.m.role !== 'admin' && photo.cree_par !== req.m.id) return res.status(403).json({ erreur: 'Seule la personne qui gère cet album peut supprimer cette photo.' });
  db.prepare('DELETE FROM photos WHERE id=? AND famille_id=?').run(photo.id,req.m.famille_id); res.sendStatus(204);
});
app.post('/api/pantry', auth, droit('courses'), (req, res) => {
  const nom = String(req.body.nom || '').trim().slice(0, 80), statut = req.body.statut === 'needed' ? 'needed' : 'stock';
  if (!nom) return res.status(400).json({ erreur: 'Indiquez un ingrédient.' });
  db.prepare('INSERT INTO pantry(famille_id,nom,statut) VALUES(?,?,?) ON CONFLICT(famille_id,nom) DO UPDATE SET statut=excluded.statut').run(req.m.famille_id, nom.toLowerCase(), statut);
  res.sendStatus(201);
});
app.patch('/api/pantry/:id', auth, droit('courses'), (req, res) => {
  if (!['stock','needed'].includes(req.body.statut)) return res.status(400).json({ erreur: 'Statut invalide.' });
  db.prepare('UPDATE pantry SET statut=? WHERE id=? AND famille_id=?').run(req.body.statut, req.params.id, req.m.famille_id); res.json({ ok: true });
});
app.delete('/api/pantry/:id', auth, droit('courses'), (req, res) => {
  db.prepare('DELETE FROM pantry WHERE id=? AND famille_id=?').run(req.params.id, req.m.famille_id); res.sendStatus(204);
});

app.get('/api/admin/foyer-code',auth,admin,(req,res)=>res.set('Cache-Control','no-store').json({foyerCode:fam(req.m.famille_id).foyer_code}));
app.post('/api/admin/foyer-code/regenerer',auth,admin,(req,res)=>{const code=nouveauCodeFoyer();db.prepare('UPDATE familles SET foyer_code=? WHERE id=?').run(code,req.m.famille_id);res.set('Cache-Control','no-store').json({foyerCode:code});});
app.patch('/api/photos/intervalle', auth, admin, (req, res) => {
  const s = Math.min(300, Math.max(3, +req.body.secondes || 10));
  db.prepare('UPDATE familles SET intervalle_photos=? WHERE id=?').run(s, req.m.famille_id); res.json({ intervalle_secondes: s });
});

// --- Courses ---
app.post('/api/courses', auth, droit('courses'), (req, res) => {
  const { nom, assigne_a = req.m.id, coins: c = 2 } = req.body;
  if(!db.prepare('SELECT 1 FROM membres WHERE id=? AND famille_id=?').get(assigne_a,req.m.famille_id))return res.status(400).json({erreur:'Membre hors du foyer.'});
  const id = db.prepare('INSERT INTO courses(famille_id,nom,ajoute_par,assigne_a,coins) VALUES(?,?,?,?,?)').run(req.m.famille_id, nom, req.m.id, assigne_a, c).lastInsertRowid;
  db.prepare("INSERT INTO pantry(famille_id,nom,statut) VALUES(?,lower(trim(?)),'needed') ON CONFLICT(famille_id,nom) DO UPDATE SET statut='needed'").run(req.m.famille_id, nom);
  res.status(201).json({ id });
});
app.post('/api/courses/:id/basculer', auth, droit('courses'), (req, res) => {
  const c = db.prepare('SELECT * FROM courses WHERE id=? AND famille_id=?').get(req.params.id, req.m.famille_id);
  if (!c) return res.sendStatus(404);
  if (c.achete_par) { db.prepare('UPDATE courses SET achete_par=NULL, achete_le=NULL WHERE id=? AND famille_id=?').run(c.id,req.m.famille_id); db.prepare("INSERT INTO pantry(famille_id,nom,statut) VALUES(?,lower(trim(?)),'needed') ON CONFLICT(famille_id,nom) DO UPDATE SET statut='needed'").run(req.m.famille_id,c.nom); return res.json({}); }
  db.prepare("UPDATE courses SET achete_par=?, achete_le=datetime('now') WHERE id=?").run(req.m.id, c.id);
  db.prepare("INSERT INTO pantry(famille_id,nom,statut) VALUES(?,lower(trim(?)),'stock') ON CONFLICT(famille_id,nom) DO UPDATE SET statut='stock'").run(req.m.famille_id,c.nom);
  let g = 0;
  if (!c.coins_verses) { g = c.coins; coins(c.assigne_a || req.m.id, g, `Course : ${c.nom}`); db.prepare('UPDATE courses SET coins_verses=1 WHERE id=? AND famille_id=?').run(c.id,req.m.famille_id); }
  res.json({ supercoins_gagnes: g });
});
app.delete('/api/courses/:id', auth, droit('courses'), (req, res) => { const row=db.prepare('SELECT nom,achete_par FROM courses WHERE id=? AND famille_id=?').get(req.params.id,req.m.famille_id); if(row&&!row.achete_par) db.prepare("DELETE FROM pantry WHERE famille_id=? AND nom=lower(trim(?)) AND statut='needed'").run(req.m.famille_id,row.nom); db.prepare('DELETE FROM courses WHERE id=? AND famille_id=?').run(req.params.id, req.m.famille_id); res.sendStatus(204); });

// --- Suggestions web, avec replis successifs adaptés aux hébergeurs cloud ---
const FR_SOURCES = [
  {name:'Marmiton',host:'www.marmiton.org',search:i=>`https://www.marmiton.org/recettes/recherche.aspx?aqt=${encodeURIComponent(i.join('-'))}`},
  {name:'750g',host:'www.750g.com',search:i=>`https://www.750g.com/recherche.htm?search=${encodeURIComponent(i.join(' '))}`},
  {name:'CuisineAZ',host:'www.cuisineaz.com',search:i=>`https://www.cuisineaz.com/recherche.aspx?search=${encodeURIComponent(i.join(' '))}`},
  {name:'Ptitchef',host:'www.ptitchef.com',search:i=>`https://www.ptitchef.com/recettes/search?query=${encodeURIComponent(i.join(' '))}`},
  {name:'Journal des Femmes Cuisine',host:'cuisine.journaldesfemmes.fr',search:i=>`https://cuisine.journaldesfemmes.fr/recherche/?q=${encodeURIComponent(i.join(' '))}`},
  {name:'Cuisine Actuelle',host:'www.cuisineactuelle.fr',search:i=>`https://www.cuisineactuelle.fr/recherche?query=${encodeURIComponent(i.join(' '))}`}
];
const RECIPE_CACHE=new Map();
const htmlText=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/\s+/g,' ').trim();
const jsonLdRecipes=html=>{const out=[];for(const m of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{const walk=x=>{if(!x)return;if(Array.isArray(x))return x.forEach(walk);if(typeof x==='object'){const t=x['@type'];if((Array.isArray(t)?t:[t]).some(v=>/\bRecipe\b/i.test(String(v||''))))out.push(x);if(x['@graph'])walk(x['@graph']);}};walk(JSON.parse(m[1]));}catch{}}return out;};
const metaContent=(html,key)=>{for(const tag of String(html).matchAll(/<meta\b[^>]*>/gi)){const attrs={};for(const m of tag[0].matchAll(/([\w:-]+)\s*=\s*(['"])(.*?)\2/gi))attrs[m[1].toLowerCase()]=m[3];if((attrs.property||attrs.name||'').toLowerCase()===key.toLowerCase()&&attrs.content)return htmlText(attrs.content);}return '';};
const recipeImage=r=>{let v=r?.image;if(Array.isArray(v))v=v[0];if(v&&typeof v==='object')v=v.url||v.contentUrl;return typeof v==='string'?v:'';};
const recipeEmoji=title=>/soupe|velouté/i.test(title)?'🥣':/salade/i.test(title)?'🥗':/gâteau|tarte|dessert|crêpe/i.test(title)?'🍰':/pâte|lasagne|spaghetti/i.test(title)?'🍝':/poulet/i.test(title)?'🍗':'🍲';
function isFrenchRecipe(text,lang){if(lang&&!/^fr(?:[-_]|$)/i.test(Array.isArray(lang)?lang.join(' '):String(lang)))return false;const t=String(text).toLowerCase();return /[àâçéèêëîïôùûüÿœ]|\b(avec|pour|dans|cuillère|cuillerée|farine|beurre|oignon|préparation|étapes|minutes|recette|mélanger|ajouter|faire cuire|four|sel|poivre|huile|tomates|pommes)\b/i.test(t)&&!/\b(ingredients|instructions|tablespoon|teaspoon|chicken breast|servings)\b/i.test(t);}
const normalizeRecipe=(r,source,url)=>{const title=htmlText(r.name),description=htmlText(r.description);const steps=(Array.isArray(r.recipeInstructions)?r.recipeInstructions:[r.recipeInstructions]).flatMap(x=>typeof x==='string'?[htmlText(x)]:x?.itemListElement?[].concat(x.itemListElement).map(y=>htmlText(y.text||y.name)):x?.text?[htmlText(x.text)]:[]).filter(Boolean);const ingredients=(r.recipeIngredient||[]).map(htmlText).filter(Boolean);if(!title||!isFrenchRecipe(`${title} ${description} ${ingredients.join(' ')} ${steps.join(' ')}`,r.inLanguage))return null;let image=recipeImage(r),recipeUrl=url;try{image=image?new URL(image,url).href:'';if(image&&!/^https?:$/.test(new URL(image).protocol))image='';}catch{image='';}try{const c=typeof r.url==='string'?r.url:(typeof r.mainEntityOfPage==='string'?r.mainEntityOfPage:r.mainEntityOfPage?.['@id']);if(c)recipeUrl=new URL(c,url).href;}catch{}return {id:'fr-'+Buffer.from(recipeUrl).toString('base64url'),title,emoji:recipeEmoji(title),image:image||null,category:htmlText(r.recipeCategory||''),area:'France',ingredients:ingredients.map(name=>({name,measure:''})),available:[],onShoppingList:[],toBuy:[],instructions:steps.join('\n\n')||description,description,source:recipeUrl,sourceName:source,sourceType:'francais',matched:[]};};
function recipeFromMeta(html,source,url){const title=metaContent(html,'og:title')||metaContent(html,'twitter:title')||htmlText(String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);const description=metaContent(html,'og:description')||metaContent(html,'description');if(!title||!isFrenchRecipe(title+' '+description))return null;let image=metaContent(html,'og:image')||metaContent(html,'twitter:image');try{image=image?new URL(image,url).href:''}catch{image=''}return {id:'fr-'+Buffer.from(url).toString('base64url'),title,emoji:recipeEmoji(title),image:image||null,category:'',area:'France',ingredients:[],available:[],onShoppingList:[],toBuy:[],instructions:description,description,source:url,sourceName:source,sourceType:'francais',matched:[]};}
const KNOWN_RECIPE_HOSTS=new Set(FR_SOURCES.map(s=>s.host.toLowerCase().replace(/^www\./,'')));
const sourceAllowsHost=(source,hostname)=>{const root=source.host.toLowerCase().replace(/^www\./,'');const host=String(hostname||'').toLowerCase().replace(/^www\./,'');return host===root||host.endsWith('.'+root)};
function isRecipeUrl(u){const h=u.hostname.toLowerCase().replace(/^www\./,'');if(![...KNOWN_RECIPE_HOSTS].some(x=>h===x||h.endsWith('.'+x)))return false;if(/facebook|instagram|tiktok|youtube|pinterest|twitter|x\.com|google\.|bing\.|duckduckgo/i.test(h))return false;const p=u.pathname.toLowerCase();if(/recherche|search|categorie|category|\/tag\/|\/auteur\//i.test(p))return false;return /recette|recipe|cuisine|plat|gateau|dessert|entree|accompagnement/i.test(p);}
function searchResultUrls(html,base){const out=[],seen=new Set();for(const m of String(html).matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)){let raw=htmlText(m[2]);try{let wrap=new URL(raw,base);if(/(^|\.)google\.(?:fr|com)$/.test(wrap.hostname)&&wrap.pathname==='/url')raw=wrap.searchParams.get('q')||wrap.searchParams.get('url')||'';else if(/duckduckgo\.com$/.test(wrap.hostname)&&/\/l\//.test(wrap.pathname))raw=wrap.searchParams.get('uddg')||'';else if(/bing\.com$/.test(wrap.hostname)&&wrap.searchParams.has('url'))raw=wrap.searchParams.get('url')||'';else if(/^\/(?:url\?|url\?sa=)/.test(raw)){const g=new URL(raw,'https://www.google.fr');raw=g.searchParams.get('q')||g.searchParams.get('url')||'';}if(!raw)continue;const u=new URL(raw,base);if(u.protocol!=='https:'||!isRecipeUrl(u)||seen.has(u.href))continue;seen.add(u.href);const title=htmlText(m[3]).slice(0,180);if(title.length>3)out.push({url:u.href,title});}catch{}}return out;}
async function fetchPage(url,timeout=5200,headers={}){return fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1','Accept':'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8','Accept-Language':'fr-FR,fr;q=0.9,en;q=0.5',...headers},signal:AbortSignal.timeout(timeout),redirect:'follow'});}
const DDG={name:'DuckDuckGo HTML',url:q=>`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=fr-fr&s=${Math.floor(Math.random()*4)*30}`};
const BING={name:'Bing',url:q=>`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=fr&cc=FR&first=${1+Math.floor(Math.random()*4)*10}`};
const allowedSites=FR_SOURCES.map(x=>'site:'+x.host.replace(/^www\./,'')).join(' OR ');
async function enrichSearchLinks(rows,sourceName,exclude){const results=[];for(let i=0;i<rows.length&&results.length<12;i+=3){const settled=await Promise.allSettled(rows.slice(i,i+3).map(async row=>{if(exclude.has(row.url))return null;const resp=await fetchPage(row.url,4200);if(!resp.ok)throw Error('HTTP '+resp.status);const html=await resp.text();const recipe=jsonLdRecipes(html).map(x=>normalizeRecipe(x,sourceName,resp.url||row.url)).find(Boolean);const meta=recipe||recipeFromMeta(html,sourceName,resp.url||row.url);if(!meta)return null;if(!meta.title)meta.title=row.title;if(!meta.image){const raw=metaContent(html,'og:image')||metaContent(html,'twitter:image');try{meta.image=raw?new URL(raw,resp.url||row.url).href:null}catch{meta.image=null}}if(!meta.ingredients?.length)meta.ingredients=[];return meta;}));for(const x of settled)if(x.status==='fulfilled'&&x.value&&!results.some(r=>r.source===x.value.source))results.push(x.value);}return results;}
async function recipesFromSearchEngine(engine,query,exclude){const searchUrl=engine.url(query);const response=await fetchPage(searchUrl,5000);if(!response.ok)throw Error('HTTP '+response.status);const html=await response.text();if(/captcha|robot check|unusual traffic|before you continue/i.test(html))throw Error('page de consentement ou CAPTCHA');const links=searchResultUrls(html,response.url||searchUrl);if(!links.length)throw Error('aucun résultat francophone exploitable');return enrichSearchLinks(links,engine.name,exclude);}
async function recipesFromSource(source,ingredients,exclude){const searchUrl=source.search(ingredients);const response=await fetchPage(searchUrl);if(!response.ok)throw Error('HTTP '+response.status);const html=await response.text(),base=response.url||searchUrl,found=[];for(const r of jsonLdRecipes(html)){const rec=normalizeRecipe(r,source.name,base);if(rec&&sourceAllowsHost(source,new URL(rec.source).hostname)&&!exclude.has(rec.source)&&!exclude.has(rec.id))found.push(rec);}if(found.length)return found;const links=searchResultUrls(html,base).filter(x=>sourceAllowsHost(source,new URL(x.url).hostname)).slice(0,12);const enriched=await enrichSearchLinks(links,source.name,exclude);if(!enriched.length&&links.length)throw Error('résultats détectés, mais aucune fiche exploitable (JSON-LD/métadonnées absents)');if(!links.length)throw Error('aucun lien de recette exploitable dans le HTML');return enriched;}
const mealName=i=>({boeuf:'beef',bœuf:'beef',poulet:'chicken',riz:'rice',pomme:'apple',pommes:'apple',tomate:'tomato',tomates:'tomato',oeuf:'egg',œuf:'egg',oeufs:'egg',œufs:'egg',poisson:'fish',saumon:'salmon',pâtes:'pasta',pate:'pasta',pâtes:'pasta',lait:'milk',fromage:'cheese',oignon:'onion',carotte:'carrot',carottes:'carrot',pomme_de_terre:'potato','pommes de terre':'potato',crème:'cream',creme:'cream',champignon:'mushroom',lentilles:'lentils',haricots:'beans',crevette:'prawn',crevettes:'prawn'})[String(i).toLocaleLowerCase('fr').normalize('NFC')]||String(i).toLowerCase().replace(/[^a-z\s-]/g,'').trim();
async function recipesFromMealDb(ingredients,exclude,offset=0){const names=ingredients.map(mealName).filter(Boolean);const all=[];const results=await Promise.allSettled(names.map(async ingredient=>{const url='https://www.themealdb.com/api/json/v1/1/filter.php?i='+encodeURIComponent(ingredient);const response=await fetchPage(url,4500,{'Accept':'application/json'});if(!response.ok)throw Error('HTTP '+response.status);const data=await response.json();return (data.meals||[]).map(m=>({m,ingredient}));}));const failed=results.filter(x=>x.status==='rejected');for(const x of results)if(x.status==='fulfilled')all.push(...x.value);if(!all.length)throw Error(failed.length===results.length?'API TheMealDB indisponible ('+failed.map(x=>x.reason?.message||'erreur').join(', ')+')':'aucun résultat API pour les ingrédients');const seen=new Set();const rows=[];for(const {m,ingredient} of all){if(seen.has(String(m.idMeal)))continue;seen.add(String(m.idMeal));const url='https://www.themealdb.com/meal/'+encodeURIComponent(m.idMeal);const id='mealdb-'+m.idMeal;if(exclude.has(id)||exclude.has(url))continue;rows.push({id,title:String(m.strMeal||'Recette TheMealDB'),emoji:recipeEmoji(m.strMeal||''),image:m.strMealThumb||null,category:'',area:'',ingredients:[{name:ingredient,measure:''}],available:[],onShoppingList:[],toBuy:[],instructions:'Consultez la recette et sa préparation sur TheMealDB.',description:'Résultat issu de l’API publique TheMealDB (base de recettes principalement anglophone).',source:url,sourceName:'TheMealDB (API publique)',sourceType:'themealdb',matched:ingredients});}for(let i=rows.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[rows[i],rows[j]]=[rows[j],rows[i]]}return rows.slice(offset%Math.max(1,rows.length),offset%Math.max(1,rows.length)+12);}
function directSearchLinks(ingredients,seed,offset=0){const start=(offset/6|0)%FR_SOURCES.length;return Array.from({length:FR_SOURCES.length},(_,i)=>FR_SOURCES[(start+i)%FR_SOURCES.length]).map((source,i)=>{const base=source.search(ingredients),url=new URL(base);url.searchParams.set('mm-page',String((offset/6|0)+1));const href=url.href,id='search-'+Buffer.from(href).toString('base64url');return {id,title:`Rechercher « ${ingredients.join(' ')} » sur ${source.name}`,emoji:'🔎',image:null,category:'Recherche web',area:'',ingredients:[],available:[],onShoppingList:[],toBuy:[],instructions:'Ouvrez le lien pour consulter les résultats du site.',description:'Lien direct vers la recherche du site. Le serveur n’a pas pu extraire de fiches utilisables.',source:href,sourceName:source.name+' · lien de recherche',sourceType:'searchlink',matched:ingredients};});}
async function measure(name,fn){const started=Date.now();try{const rows=await fn();return {name,status:'ok',count:rows.length,durationMs:Date.now()-started,error:null,rows};}catch(e){return {name,status:'échec',count:0,durationMs:Date.now()-started,error:String(e?.message||e)};}}
const ingredientKey=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('fr').replace(/[^a-z0-9]+/g,' ').trim();
const ingredientsMatch=(a,b)=>{const x=ingredientKey(a),y=ingredientKey(b);return !!x&&!!y&&(x===y||x.includes(y)||y.includes(x));};
const pantryTerms=fid=>{const rows=db.prepare('SELECT nom,statut FROM pantry WHERE famille_id=?').all(fid);const stock=rows.filter(x=>x.statut==='stock').map(x=>x.nom),needed=rows.filter(x=>x.statut==='needed').map(x=>x.nom);return {stock,needed,ingredients:[...new Set(stock.length?stock:needed)]};};
function cleanQueryIngredients(query){return [...new Set(String(query||'').split(/[,+]/).map(x=>x.trim()).filter(Boolean))].slice(0,5);}
async function directDiagnostics(ingredients,exclude){const query=`recette ${ingredients.join(' ')} (${allowedSites})`;const direct=await Promise.all(FR_SOURCES.map(s=>measure(s.name,()=>recipesFromSource(s,ingredients,exclude))));const ddg=await measure(DDG.name,()=>recipesFromSearchEngine(DDG,query,exclude));const bing=await measure(BING.name,()=>recipesFromSearchEngine(BING,query,exclude));const meal=await measure('TheMealDB (API publique)',()=>recipesFromMealDb(ingredients,exclude));return [...direct,ddg,bing,meal];}
app.get('/api/recipes/debug', async(req,res)=>{const ingredients=cleanQueryIngredients(req.query.q);if(!ingredients.length)return res.status(400).json({erreur:'Indiquez des ingrédients avec ?q=poulet+riz'});try{const results=await directDiagnostics(ingredients,new Set(String(req.query.exclude||'').split(',').filter(Boolean)));return res.json({query:ingredients.join(' '),sources:results.map(({name,status,count,durationMs,error})=>({source:name,status,count,durationMs,error}))});}catch(e){console.error('[recipes/debug] Diagnostic échoué :',e);return res.status(200).json({query:ingredients.join(' '),sources:[],error:'Diagnostic temporairement indisponible.'});}});
app.get('/api/recettes/suggestions', auth, droit('recettes'), async (req,res) => {
  try {
  const pantry=pantryTerms(req.m.famille_id);
  const ingredients=cleanQueryIngredients(req.query.ingredients||pantry.ingredients.join(','));
  if(!ingredients.length)return res.json({recipes:[],hasMore:false,nextOffset:0,message:'Le garde-manger est vide. Ajoutez un ou plusieurs ingrédients avant de lancer la recherche.'});
  const excluded=new Set(String(req.query.exclude||'').split(',').filter(Boolean).slice(0,180));
  const offset=Math.max(0,Number.parseInt(req.query.offset||'0',10)||0);
  const query=`recette ${ingredients.join(' ')} (${allowedSites})`;
  const diagnostics=[];let rows=[];let provider='';
  const directResults=await Promise.all(FR_SOURCES.map(source=>measure(source.name,()=>recipesFromSource(source,ingredients,excluded))));diagnostics.push(...directResults);for(const result of directResults)if(result.rows?.length)rows.push(...result.rows);
  if(rows.length)provider='Sites culinaires francophones';
  if(!rows.length){const result=await measure(DDG.name,()=>recipesFromSearchEngine(DDG,query,excluded));diagnostics.push(result);rows=result.rows||[];if(rows.length)provider=DDG.name;}
  if(!rows.length){const result=await measure(BING.name,()=>recipesFromSearchEngine(BING,query,excluded));diagnostics.push(result);rows=result.rows||[];if(rows.length)provider=BING.name;}
  if(!rows.length){const result=await measure('TheMealDB (API publique)',()=>recipesFromMealDb(ingredients,excluded,offset));diagnostics.push(result);rows=result.rows||[];if(rows.length)provider='TheMealDB (API publique)';}
  const stock=pantry.stock,needed=pantry.needed;
  rows=rows.filter(r=>!excluded.has(r.source)&&!excluded.has(r.id));
  for(const recipe of rows){if(recipe.sourceType==='themealdb'){recipe.toBuy=[];recipe.available=recipe.ingredients.map(x=>x.name);continue}if(recipe.sourceType==='searchlink'){recipe.toBuy=[];recipe.available=[];continue}const items=Array.isArray(recipe.ingredients)?recipe.ingredients:[];recipe.available=items.filter(item=>stock.some(x=>ingredientsMatch(x,item.name))).map(item=>item.name);recipe.onShoppingList=items.filter(item=>needed.some(x=>ingredientsMatch(x,item.name))).map(item=>item.name);recipe.toBuy=items.filter(item=>!stock.some(x=>ingredientsMatch(x,item.name))&&!needed.some(x=>ingredientsMatch(x,item.name))).map(item=>item.name);recipe.matched=ingredients.filter(i=>items.some(x=>ingredientsMatch(i,x.name)));}
  for(let i=rows.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[rows[i],rows[j]]=[rows[j],rows[i]]}
  // Résultats paginés par lots; les suivants sont exclus via la session du client.
  let page=rows.slice(0,6);page.forEach(r=>RECIPE_CACHE.set(String(req.m.famille_id)+':'+r.id,r));
  const failures=diagnostics.filter(x=>x.status==='échec');
  let message='';if(failures.length)message='Sources indisponibles: '+failures.map(x=>`${x.name} — ${x.error}`).join(' · ');if(provider==='TheMealDB (API publique)')message=(message?message+' · ':'')+'Résultats issus de l’API publique TheMealDB (source principalement anglophone).';
  if(!page.length){const links=directSearchLinks(ingredients,String(req.query.seed||Date.now()),offset);const available=links.filter(r=>!excluded.has(r.id)&&!excluded.has(r.source));const fallback=available.length?available:directSearchLinks(ingredients,Date.now()+'',offset+6);fallback.forEach(r=>RECIPE_CACHE.set(String(req.m.famille_id)+':'+r.id,r));page=fallback;provider='Liens directs de recherche';message=(message?message+' · ':'')+'Aucune fiche exploitable reçue des sources; liens directs de recherche disponibles. '+failures.slice(0,3).map(x=>`${x.name}: ${x.error}`).join(' · ');}
  const moreAvailable=rows.length>page.length||provider==='Liens directs de recherche'||provider==='TheMealDB (API publique)';
  return res.status(200).json({recipes:page,hasMore:moreAvailable,nextOffset:offset+page.length,message,provider,diagnostics:diagnostics.map(({name,status,count,error})=>({source:name,status,count,error}))});
  } catch(e) {
    console.error('[recettes/suggestions] Recherche en repli après exception :',e);
    const ingredients=cleanQueryIngredients(req.query?.ingredients||'').length?cleanQueryIngredients(req.query.ingredients):['repas'];
    const offset=Math.max(0,Number.parseInt(req.query?.offset||'0',10)||0);
    const recipes=directSearchLinks(ingredients,String(req.query?.seed||Date.now()),offset).slice(0,6);
    for(const recipe of recipes)RECIPE_CACHE.set(String(req.m.famille_id)+':'+recipe.id,recipe);
    return res.status(200).json({recipes,hasMore:true,nextOffset:offset+recipes.length,message:'La recherche en ligne est temporairement indisponible. Voici des liens de recherche directs ; réessayez dans quelques instants.',provider:'Liens directs de recherche',diagnostics:[]});
  }
});
app.get('/api/recettes/suggestions/:id',auth,droit('recettes'),async(req,res)=>{let recipe=RECIPE_CACHE.get(String(req.m.famille_id)+':'+req.params.id);if(!recipe&&req.params.id.startsWith('mealdb-')){try{const id=encodeURIComponent(req.params.id.slice(7)),response=await fetchPage('https://www.themealdb.com/api/json/v1/1/lookup.php?i='+id,4500,{'Accept':'application/json'});if(response.ok){const meal=(await response.json()).meals?.[0];if(meal)recipe={id:req.params.id,title:meal.strMeal||'Recette TheMealDB',emoji:recipeEmoji(meal.strMeal||''),image:meal.strMealThumb||null,category:meal.strCategory||'',area:meal.strArea||'',ingredients:Array.from({length:20},(_,i)=>({name:meal['strIngredient'+(i+1)],measure:meal['strMeasure'+(i+1)]||''})).filter(x=>x.name?.trim()),instructions:meal.strInstructions||'',description:'Résultat issu de l’API publique TheMealDB.',source:'https://www.themealdb.com/meal/'+id,sourceName:'TheMealDB (API publique)',sourceType:'themealdb',matched:[]};}}catch{}}if(!recipe)return res.status(404).json({erreur:'Cette recette détaillée n’est plus accessible. Relancez la recherche.'});res.json(recipe);});
// --- Recettes ---
app.post('/api/recettes', auth, droit('recettes'), (req, res) => {
  const { titre, categorie, ingredients, etapes = '', emoji = '🍽️', duree = '' } = req.body;
  res.status(201).json({ id: db.prepare('INSERT INTO recettes(famille_id,titre,categorie,ingredients,etapes,emoji,duree) VALUES(?,?,?,?,?,?,?)').run(req.m.famille_id, titre, categorie, JSON.stringify(ingredients), etapes, emoji, duree).lastInsertRowid });
});
app.put('/api/recette-favoris', auth, droit('recettes'), (req, res) => {
  const { source = 'local', id, title, data = {} } = req.body;
  if (!['local','francais','themealdb'].includes(source) || !id || !title) return res.status(400).json({ erreur: 'Recette invalide.' });
  const safe = JSON.stringify({ title, image: data.image || '', emoji: data.emoji || '🍲', category: data.category || '', area: data.area || '', ingredients: Array.isArray(data.ingredients) ? data.ingredients : [], instructions: data.instructions || '', description: data.description || '', sourceUrl: data.sourceUrl || '', sourceName: data.sourceName || '' });
  db.prepare('INSERT OR REPLACE INTO recipe_favorites(famille_id,membre_id,source,recette_id,titre,donnees) VALUES(?,?,?,?,?,?)').run(req.m.famille_id, req.m.id, source, String(id), String(title).slice(0,160), safe);
  res.sendStatus(204);
});
app.delete('/api/recette-favoris/:source/:id', auth, droit('recettes'), (req, res) => {
  db.prepare('DELETE FROM recipe_favorites WHERE membre_id=? AND source=? AND recette_id=? AND famille_id=?').run(req.m.id, req.params.source, req.params.id, req.m.famille_id);
  if (req.params.source === 'local' && /^\d+$/.test(req.params.id)) db.prepare('DELETE FROM favoris WHERE membre_id=? AND recette_id=?').run(req.m.id, req.params.id);
  res.sendStatus(204);
});
app.put('/api/recettes/:id/favori', auth, (req, res) => { if(!db.prepare('SELECT 1 FROM recettes WHERE id=? AND famille_id=?').get(req.params.id,req.m.famille_id))return res.sendStatus(404);db.prepare('INSERT OR IGNORE INTO favoris VALUES(?,?)').run(req.m.id, req.params.id); res.sendStatus(204); });
app.delete('/api/recettes/:id/favori', auth, (req, res) => { if(!db.prepare('SELECT 1 FROM recettes WHERE id=? AND famille_id=?').get(req.params.id,req.m.famille_id))return res.sendStatus(404);db.prepare('DELETE FROM favoris WHERE membre_id=? AND recette_id=?').run(req.m.id, req.params.id); res.sendStatus(204); });

// --- Tâches ---
app.post('/api/taches', auth, droit('taches'), (req, res) => {
  const { titre, assigne_a, coins: c = 5, date_prevue = null } = req.body, statut = req.m.role === 'admin' ? 'ouverte' : 'en_attente_validation';
  if(!db.prepare('SELECT 1 FROM membres WHERE id=? AND famille_id=?').get(assigne_a,req.m.famille_id))return res.status(400).json({erreur:'Membre hors du foyer.'});
  res.status(201).json({ id: db.prepare('INSERT INTO taches(famille_id,titre,cree_par,assigne_a,coins,statut,date_prevue) VALUES(?,?,?,?,?,?,?)').run(req.m.famille_id, titre, req.m.id, assigne_a, Math.min(100, c), statut, date_prevue || null).lastInsertRowid, statut });
});
app.post('/api/taches/:id/validation', auth, admin, (req, res) => {
  db.prepare("UPDATE taches SET statut=? WHERE id=? AND famille_id=? AND statut='en_attente_validation'").run(req.body.accepter ? 'ouverte' : 'refusee', req.params.id, req.m.famille_id); res.json({ ok: true });
});
app.post('/api/taches/:id/fait', auth, (req, res) => {
  const t = db.prepare("SELECT * FROM taches WHERE id=? AND famille_id=? AND statut='ouverte'").get(req.params.id, req.m.famille_id);
  if (!t || (t.assigne_a !== req.m.id && req.m.role !== 'admin')) return res.status(404).json({ erreur: 'Tâche introuvable' });
  db.prepare("UPDATE taches SET statut='faite', fait_le=datetime('now') WHERE id=?").run(t.id);
  coins(t.assigne_a, t.coins, `Tâche : ${t.titre}`); res.json({ supercoins_gagnes: t.coins });
});
const rewardRow=row=>({id:String(row.id),title:row.titre,cost:row.cout,members:JSON.parse(row.membres||'[]').map(String)});
const rewardInput=(body,fid)=>{const title=String(body?.title||'').trim().slice(0,120),cost=Number(body?.cost??0);let members=body?.members;if(!Array.isArray(members))members=members==null?[]:[members];members=[...new Set(members.map(String))];if(!title)throw Object.assign(Error('Indiquez le nom de la récompense.'),{status:400});if(!Number.isInteger(cost)||cost<0||cost>100000)throw Object.assign(Error('Le coût en SuperCoins doit être un entier positif.'),{status:400});if(members.length){const valid=db.prepare(`SELECT id FROM membres WHERE famille_id=? AND id IN (${members.map(()=>'?').join(',')})`).all(fid,...members).map(x=>String(x.id));if(valid.length!==members.length)throw Object.assign(Error('Un ou plusieurs membres ne font pas partie du foyer.'),{status:400});}return {title,cost,members};};
app.get('/api/recompenses-foyer',auth,(req,res)=>res.json({rewards:db.prepare('SELECT * FROM family_rewards WHERE famille_id=? ORDER BY id DESC').all(req.m.famille_id).map(rewardRow)}));
app.post('/api/recompenses-foyer',auth,admin,(req,res)=>{try{const x=rewardInput(req.body,req.m.famille_id),id=db.prepare('INSERT INTO family_rewards(famille_id,titre,cout,membres) VALUES(?,?,?,?)').run(req.m.famille_id,x.title,x.cost,JSON.stringify(x.members)).lastInsertRowid;res.status(201).json({id:String(id),...x});}catch(e){res.status(e.status||400).json({erreur:e.message});}});
app.put('/api/recompenses-foyer/:id',auth,admin,(req,res)=>{try{const x=rewardInput(req.body,req.m.famille_id),r=db.prepare('UPDATE family_rewards SET titre=?,cout=?,membres=? WHERE id=? AND famille_id=?').run(x.title,x.cost,JSON.stringify(x.members),req.params.id,req.m.famille_id);if(!r.changes)return res.status(404).json({erreur:'Récompense introuvable.'});res.json({id:String(req.params.id),...x});}catch(e){res.status(e.status||400).json({erreur:e.message});}});
app.delete('/api/recompenses-foyer/:id',auth,admin,(req,res)=>{const r=db.prepare('DELETE FROM family_rewards WHERE id=? AND famille_id=?').run(req.params.id,req.m.famille_id);if(!r.changes)return res.status(404).json({erreur:'Récompense introuvable.'});res.sendStatus(204);});
app.post('/api/recompenses', auth, admin, (req, res) => {
  if(!db.prepare('SELECT 1 FROM membres WHERE id=? AND famille_id=?').get(req.body.membre_id,req.m.famille_id))return res.status(400).json({erreur:'Membre hors du foyer.'});
  db.prepare('INSERT INTO recompenses(famille_id,membre_id,libelle,seuil) VALUES(?,?,?,?)').run(req.m.famille_id, req.body.membre_id, req.body.libelle, req.body.seuil); res.sendStatus(201);
});

// --- État complet (format attendu par l'interface) ---
const S = String;
app.get('/api/etat', auth, async (req, res) => {
  const fid = req.m.famille_id, q = (sql, ...p) => db.prepare(sql).all(...p), f = fam(fid);
  const fav = new Set(q('SELECT recette_id r FROM favoris WHERE membre_id=?', req.m.id).map(x => String(x.r)));
  const allLikes = q('SELECT rf.*, m.nom AS member_name FROM recipe_favorites rf JOIN membres m ON m.id=rf.membre_id WHERE rf.famille_id=?', fid);
  const legacyLikes = q('SELECT f.recette_id, f.membre_id, m.nom AS member_name FROM favoris f JOIN recettes r ON r.id=f.recette_id JOIN membres m ON m.id=f.membre_id WHERE r.famille_id=?', fid).map(x => ({ source:'local', recette_id:String(x.recette_id), membre_id:x.membre_id, member_name:x.member_name }));
  const ph = q('SELECT * FROM photos WHERE famille_id=?', fid);
  const inv = db.prepare("SELECT * FROM invitations WHERE famille_id=? AND statut='active' AND expire_le>? ORDER BY id DESC").get(fid, Date.now());
  const ST = { ouverte: 'assigned', en_attente_validation: 'pending', faite: 'done' };
  const inviteQrData=inv?await QRCode.toDataURL(invitationUrl(inv.code),{errorCorrectionLevel:'M',margin:1,width:220}):null;
  const currentMonth=new Date().toISOString().slice(0,7), familyReward=db.prepare('SELECT libelle FROM recompenses_foyer WHERE famille_id=? AND mois=?').get(fid,currentMonth)?.libelle||'';
  res.json({
    familyName: f.nom, foyerCode: req.m.role==='admin'?f.foyer_code:null, activeId: S(req.m.id), photoInterval: f.intervalle_photos, familyMonthlyReward:{month:currentMonth,label:familyReward}, rewards:db.prepare('SELECT * FROM family_rewards WHERE famille_id=? ORDER BY id DESC').all(fid).map(rewardRow), adminPasswordSet:!!req.m.mdp,
    limite: { max: MAX_UTILISATEURS, utilisateurs: utilisateurs(fid) },
    albums: q('SELECT a.*, m.nom AS proprietaire FROM albums a JOIN membres m ON m.id=a.cree_par WHERE a.famille_id=? ORDER BY a.id', fid).map(a => ({ id: S(a.id), name: a.nom, ownerId: S(a.cree_par), ownerName: a.proprietaire })),
    pantry: q('SELECT * FROM pantry WHERE famille_id=? ORDER BY statut DESC, nom', fid).map(x => ({ id: S(x.id), name: x.nom, status: x.statut })),
    members: q('SELECT * FROM membres WHERE famille_id=?', fid).map(m => ({ id: S(m.id), name: m.nom, email:m.email, emoji: m.emoji, avatar: m.avatar_data || null, color: m.couleur, role: m.role === 'admin' ? 'admin' : 'member', coins: m.supercoins, droits: JSON.parse(m.droits) })),
    events: q('SELECT * FROM rendezvous WHERE famille_id=?', fid).map(e => ({ id: S(e.id), title: e.titre, date: e.debut, endDate:e.fin||e.debut, emoji: e.emoji, memberId: S(e.membre_id), place: e.lieu || '' })),
    shopping: q('SELECT * FROM courses WHERE famille_id=? ORDER BY id', fid).map(c => ({ id: S(c.id), name: c.nom, checked: !!c.achete_par, coins: c.coins, assignee: S(c.assigne_a || c.ajoute_par) })),
    recipes: q('SELECT * FROM recettes WHERE famille_id=?', fid).map(r => ({ id: S(r.id), title: r.titre, emoji: r.emoji, category: r.categorie, ingredients: JSON.parse(r.ingredients), time: r.duree, favorite: fav.has(String(r.id)) || allLikes.some(x => x.source === 'local' && x.recette_id === String(r.id) && x.membre_id === req.m.id), likedBy: [...new Set([...allLikes.filter(x => x.source === 'local' && x.recette_id === String(r.id)).map(x => x.member_name), ...legacyLikes.filter(x => x.recette_id === String(r.id)).map(x => x.member_name)])] })),
    recipeFavorites: [...allLikes.map(x => ({ source:x.source, id:x.recette_id, title:x.titre, data:JSON.parse(x.donnees), memberId:S(x.membre_id), memberName:x.member_name })), ...legacyLikes.map(x => ({ source:'local', id:x.recette_id, title:q('SELECT titre FROM recettes WHERE id=?', x.recette_id)[0]?.titre || 'Recette', data:{}, memberId:S(x.membre_id), memberName:x.member_name }))],
    tasks: q("SELECT * FROM taches WHERE famille_id=? AND statut!='refusee' ORDER BY id", fid).map(t => ({ id: S(t.id), title: t.titre, assignee: S(t.assigne_a), coins: t.coins, status: ST[t.statut], dueDate:t.date_prevue||null, doneAt:t.fait_le||null })),
    photos: ph.map(p => ({ id: S(p.id), emoji: p.emoji, title: p.titre, caption: p.legende, colors: PALETTES[p.palette % PALETTES.length], image: p.image_data || null, albumId: S(p.album_id) })),
    invite: inv ? { id: S(inv.id), code: inv.code, name: inv.nom, email:inv.email||'', role:inv.role||'member', status: 'active', createdAt: inv.expire_le - 864e5, expiresAt: inv.expire_le, qrData:inviteQrData, url:invitationUrl(inv.code,requestBaseUrl(req)) } : null,
  });
});

app.put('/api/recompense-foyer', auth, (req,res) => { const label=String(req.body?.libelle||'').trim().slice(0,120); const month=String(req.body?.mois||new Date().toISOString().slice(0,7)); if(!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({erreur:'Mois invalide'}); db.prepare('INSERT INTO recompenses_foyer(famille_id,mois,libelle) VALUES(?,?,?) ON CONFLICT(famille_id,mois) DO UPDATE SET libelle=excluded.libelle').run(req.m.famille_id,month,label); res.json({ok:true}); });

// Fallback SPA : les routes API inconnues restent des 404 Express.
app.get('*', (req,res,next) => {
  if (req.path === '/api' || req.path.startsWith('/api/')) return next();
  res.sendFile(appFile('index.html'));
});

app.use((e, req, res, next) => {
  if (e?.type === 'entity.too.large') return res.status(413).json({ erreur: 'La requête est trop volumineuse. Choisissez une image plus petite.' });
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ erreur: 'Données envoyées invalides.' });
  console.error(e); res.status(500).json({ erreur: 'Erreur interne du hub' });
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Maison Mosaïque prête sur 0.0.0.0:${PORT} (données : ${DATA_DIR}).`);
});
