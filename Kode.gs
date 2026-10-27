/**
 * APP SCRIPT - SISTEM ABSENSI SISWA AUTOMATIS PER SENSEI (MOBILE FIRST v3.0 PROD)
 * LPK Tokyo - Kehadiran Kelas
 * 
 * Features v3.0:
 * 1. Admin: Memindahkan siswa antar kelas (misal: Esti Sensei -> Singgih Sensei) beserta absensi.
 * 2. Sensei: Hanya bisa meng-kick (mengeluarkan) siswa dari kelasnya sendiri.
 * 3. Aturan Tambah Siswa: Siswa hanya bisa ditambahkan jika belum terdaftar di kelas manapun atau sudah di-kick.
 * 4. Tracking Siswa Keluar / Siswa Bebas: Riwayat siswa yang di-kick dan siap dimasukkan ke kelas lain.
 * 5. Rekap Bulanan Fleksibel: Dukungan melihat rekap bulan & tahun lain.
 * 6. Export / Download Rekap (CSV/Excel) & Print PDF.
 */

var SPREADSHEET_ID = ""; // Kosongkan bila script dipasang di Extensions -> Apps Script

var STAFF_SENSEI_SHEET = "Absensi Staff & Sensei";
var DEFAULT_STAFF_SENSEI_NAMES = [
  "Estiyani Sensei",
  "Khaerul Sensei",
  "Robbi Sensei",
  "Rowi Sensei",
  "Singgih Sensei",
  "Evelyn Staff"
];

function isStaffSenseiSheet(name) {
  if (!name) return false;
  var n = name.toString().toLowerCase().trim();
  return n === "absensi staff & sensei" || 
         n === "staff & sensei" || 
         n === "staff dan sensei" || 
         n === "absensi staff dan sensei";
}

function getSS() {
  if (SPREADSHEET_ID && SPREADSHEET_ID.length > 10) {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

var DEFAULT_USERS = [
  { username: "singgih", password: "pass123", name: "Singgih Sensei", sheet: "Singgih Sensei, Singgih sensei Kelas karyawan", role: "sensei" },
  { username: "esti",    password: "pass123", name: "Esti Sensei",    sheet: "Esti Sensei",    role: "sensei" },
  { username: "khaerul", password: "pass123", name: "Khaerul Sensei", sheet: "Khaerul Sensei", role: "sensei" },
  { username: "robbi",   password: "pass123", name: "Robbi Sensei",   sheet: "Robbi Sensei",   role: "sensei" },
  { username: "rowi",    password: "pass123", name: "Rowi Sensei",    sheet: "Rowi Sensei, rowi sensei Kelas karyawan", role: "sensei" },
  { username: "admin",   password: "admin123", name: "Administrator",  sheet: "ALL",            role: "admin"  }
];


/* ===== KEAMANAN v3.1: token sesi (HMAC), hash password, anti brute-force, lock ===== */
var _verified = null;
function _secret() {
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperty('AUTH_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('AUTH_SECRET', s); }
  return s;
}
function _sign(t) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(t, _secret())); }
function issueToken(username) {
  var b = username + '|' + (Date.now() + 12 * 3600 * 1000);
  return b + '|' + _sign(b);
}
/** Validasi token dari client; role/akses SELALU diambil ulang dari sheet Users (tidak percaya data client). */
function authUser(u) {
  if (u && u === _verified) return u;
  var err = new Error('Sesi berakhir, silakan login ulang.');
  if (!u || !u.token) throw err;
  var p = String(u.token).split('|');
  if (p.length !== 3 || _sign(p[0] + '|' + p[1]) !== p[2] || Date.now() > Number(p[1])) throw err;
  var rec = getUsersFromSheet().filter(function(x) { return x.username === p[0]; })[0];
  if (!rec) throw err;
  _verified = { username: rec.username, name: rec.name, sheet: rec.sheet, role: rec.role };
  return _verified;
}
function hashPw(pw, salt) {
  salt = salt || Utilities.getUuid().slice(0, 8);
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + pw, Utilities.Charset.UTF_8);
  return 'sha256$' + salt + '$' + Utilities.base64Encode(d);
}
function checkPw(stored, pw) {
  stored = String(stored || '');
  if (stored.indexOf('sha256$') === 0) return hashPw(pw, stored.split('$')[1]) === stored;
  return stored === pw; // password lama (plaintext) -> otomatis di-upgrade ke hash saat login
}
function upgradePasswordHash(username, pw) {
  try {
    var sh = getSS().getSheetByName("Users"); if (!sh) return;
    var raw = sh.getDataRange().getValues();
    for (var i = 1; i < raw.length; i++) {
      if (String(raw[i][0]).toLowerCase().trim() === username) { sh.getRange(i + 1, 2).setValue(hashPw(pw)); return; }
    }
  } catch (e) {}
}
function withLock(fn) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { success: false, message: "Server sedang sibuk, coba lagi sebentar." }; }
  try { return fn(); } finally { lock.releaseLock(); }
}

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Absensi Siswa LPK Tokyo')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getWebAppUrl() {
  try {
    return ScriptApp.getService().getUrl() || "";
  } catch(err) {
    return "";
  }
}

/**
 * Authenticasi Login User
 */
function loginUser(username, password) {
  try {
    username = (username || "").toString().toLowerCase().trim();
    password = (password || "").toString().trim();

    var cache = CacheService.getScriptCache();
    var failKey = 'LOGINFAIL_' + username;
    if (Number(cache.get(failKey) || 0) >= 5) {
      return { success: false, message: "Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit." };
    }
    var users = getUsersFromSheet();
    var foundUser = null;

    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      if (u.username.toLowerCase() === username && checkPw(u.password, password)) {
        foundUser = u;
        break;
      }
    }

    if (!foundUser) {
      cache.put(failKey, String(Number(cache.get(failKey) || 0) + 1), 900);
      return { success: false, message: "Username atau password salah!" };
    }
    cache.remove(failKey);
    if (String(foundUser.password).indexOf('sha256$') !== 0) upgradePasswordHash(foundUser.username, password);

    return {
      success: true,
      message: "Login berhasil! Selamat datang, " + foundUser.name,
      user: {
        username: foundUser.username,
        name: foundUser.name,
        sheet: foundUser.sheet,
        role: foundUser.role,
        token: issueToken(foundUser.username)
      }
    };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

/**
 * Membaca data user dari sheet "Users"
 */
function getUsersFromSheet() {
  try {
    var ss = getSS();
    if (!ss) return DEFAULT_USERS;
    
    var sheet = ss.getSheetByName("Users");
    if (!sheet) {
      createUsersSheet(ss);
      return DEFAULT_USERS;
    }
    
    var raw = sheet.getDataRange().getValues();
    if (raw.length < 2) return DEFAULT_USERS;
    
    var list = [];
    for (var i = 1; i < raw.length; i++) {
      var row = raw[i];
      if (row[0]) {
        var uName = row[0].toString().toLowerCase().trim();
        var sSheet = row[3] ? row[3].toString().trim() : "";
        
        // Pastikan akun singgih dan rowi memiliki akses ke kelas karyawan
        if (uName === "singgih" && sSheet.toLowerCase().indexOf("kelas karyawan") === -1) {
          sSheet = sSheet ? (sSheet + ", Singgih sensei Kelas karyawan") : "Singgih Sensei, Singgih sensei Kelas karyawan";
          try { sheet.getRange(i + 1, 4).setValue(sSheet); } catch(e){}
        } else if (uName === "rowi" && sSheet.toLowerCase().indexOf("kelas karyawan") === -1) {
          sSheet = sSheet ? (sSheet + ", rowi sensei Kelas karyawan") : "Rowi Sensei, rowi sensei Kelas karyawan";
          try { sheet.getRange(i + 1, 4).setValue(sSheet); } catch(e){}
        }

        list.push({
          username: uName,
          password: row[1].toString().trim(),
          name: row[2].toString().trim(),
          sheet: sSheet,
          role: (row[4] || "sensei").toString().toLowerCase().trim()
        });
      }
    }
    
    return list.length > 0 ? list : DEFAULT_USERS;
  } catch (err) {
    return DEFAULT_USERS;
  }
}

/**
 * Sensei mengeset / merubah password dengan verifikasi Password Lama
 */
function updateUserPassword(username, oldPassword, newPassword) {
  try {
    username = (username || "").toString().toLowerCase().trim();
    oldPassword = (oldPassword || "").toString().trim();
    newPassword = (newPassword || "").toString().trim();

    if (!oldPassword) {
      return { success: false, message: "Password lama wajib diisi untuk verifikasi!" };
    }

    if (!newPassword || newPassword.length < 4) {
      return { success: false, message: "Password baru minimal 4 karakter!" };
    }

    var ss = getSS();
    if (!ss) return { success: false, message: "Spreadsheet tidak ditemukan." };

    var sheet = ss.getSheetByName("Users");
    if (!sheet) {
      createUsersSheet(ss);
      sheet = ss.getSheetByName("Users");
    }

    var raw = sheet.getDataRange().getValues();
    var userRowIndex = -1;
    var currentPass = "";

    for (var i = 1; i < raw.length; i++) {
      if (raw[i][0] && raw[i][0].toString().toLowerCase().trim() === username) {
        userRowIndex = i + 1;
        currentPass = raw[i][1] ? raw[i][1].toString().trim() : "";
        break;
      }
    }

    if (userRowIndex !== -1) {
      if (currentPass && !checkPw(currentPass, oldPassword)) {
        return { success: false, message: "Password lama Anda salah!" };
      }
      sheet.getRange(userRowIndex, 2).setValue(hashPw(newPassword));
      return { success: true, message: "Password untuk " + username + " berhasil diperbarui!" };
    } else {
      return { success: false, message: "User " + username + " tidak ditemukan di sistem Users." };
    }
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

/**
 * Membuat Sheet Users bila belum ada
 */
function createUsersSheet(ss) {
  try {
    var sheet = ss.insertSheet("Users");
    sheet.getRange("A1:E1").setValues([["Username", "Password", "Nama Lengkap", "Sheet Akses", "Role"]]);
    sheet.getRange("A1:E1").setFontWeight("bold").setBackground("#334155").setFontColor("#FFFFFF");
    
    var rows = DEFAULT_USERS.map(function(u) {
      return [u.username, hashPw(u.password), u.name, u.sheet, u.role];
    });
    
    sheet.getRange(2, 1, rows.length, 5).setValues(rows);
  } catch (e) {}
}

/**
 * Sheet riwayat siswa yang dikeluarkan / di-kick dari kelas
 */
function getKickedSheet(ss) {
  var sheet = ss.getSheetByName("Siswa_Keluar");
  var headers = [["Tanggal", "Nama Siswa", "Kelas Asal", "Di-kick Oleh", "Status", "Keterangan", "Kategori Penerimaan", "Catatan Admin", "History Absensi"]];
  if (!sheet) {
    sheet = ss.insertSheet("Siswa_Keluar");
    sheet.getRange(1, 1, 1, 9).setValues(headers);
    sheet.getRange(1, 1, 1, 9).setFontWeight("bold").setBackground("#334155").setFontColor("#FFFFFF");
  } else {
    // Pastikan header lengkap hingga kolom 9 (termasuk History Absensi) jika belum ada
    var curCols = Math.max(sheet.getLastColumn(), 1);
    if (curCols < 9) {
      sheet.getRange(1, 1, 1, 9).setValues(headers);
      sheet.getRange(1, 1, 1, 9).setFontWeight("bold").setBackground("#334155").setFontColor("#FFFFFF");
    }
  }
  return sheet;
}

/**
 * Helper membersihkan nomor prefix dari nama siswa
 */
function cleanStudentName(val) {
  if (val === null || val === undefined) return "";
  var str = val.toString().trim();
  var match = str.match(/^(\d+)[\.\s\-\)]+(.+)$/);
  if (match) return match[2].trim();
  return str;
}

/**
 * Helper konversi indeks kolom angka ke huruf Excel/Sheets (misal: 1 -> A, 4 -> D, 34 -> AH, 35 -> AI)
 */
function colToLetter(col) {
  var temp, letter = '';
  while (col > 0) {
    temp = (col - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    col = Math.floor((col - temp - 1) / 26);
  }
  return letter;
}

/**
 * Helper mendapatkan daftar sheet yang diizinkan untuk user
 */
function getUserAllowedSheets(currentUser) {
  if (!currentUser) return [];
  if (currentUser.role === 'admin' || currentUser.sheet === 'ALL') {
    return [];
  }
  var rawList = (currentUser.sheet || "").split(/[,;\n]+/);
  var list = [];
  for (var i = 0; i < rawList.length; i++) {
    var s = rawList[i].trim();
    if (s && list.indexOf(s) === -1) list.push(s);
  }
  var uname = (currentUser.username || "").toLowerCase().trim();
  if (uname === "singgih") {
    if (list.indexOf("Singgih Sensei") === -1) list.push("Singgih Sensei");
    if (list.indexOf("Singgih sensei Kelas karyawan") === -1) list.push("Singgih sensei Kelas karyawan");
  } else if (uname === "rowi") {
    if (list.indexOf("Rowi Sensei") === -1) list.push("Rowi Sensei");
    if (list.indexOf("rowi sensei Kelas karyawan") === -1) list.push("rowi sensei Kelas karyawan");
  }
  return list;
}

/**
 * Helper validasi apakah user berhak mengakses sheet tertentu
 */
function isUserAllowedSheet(currentUser, sheetName) {
  if (!currentUser) return false;
  if (isStaffSenseiSheet(sheetName)) {
    return currentUser.role === 'admin';
  }
  if (currentUser.role === 'admin' || currentUser.sheet === 'ALL') return true;
  var allowed = getUserAllowedSheets(currentUser);
  var target = (sheetName || "").toLowerCase().trim();
  return allowed.some(function(s) {
    return s.toLowerCase().trim() === target;
  });
}

/**
 * Mendapatkan daftar nama Sensei (HANYA MENGEMBALIKAN SHEET SENSEI YANG LOGIN BILA ROLE SENSEI)
 */
function getSenseiList(currentUser) {
  try {
    currentUser = authUser(currentUser);
    var ss = getSS();
    var allSheets = ss ? ss.getSheets().map(function(s) { return s.getName(); }) : [];
    
    var validSheets = allSheets.filter(function(name) {
      return name !== "Users" && name !== "Settings" && name !== "Siswa_Keluar" && !isStaffSenseiSheet(name) && name.toLowerCase().indexOf('rekap') === -1;
    });

    if (validSheets.length === 0) {
      validSheets = [
        "Singgih Sensei", 
        "Esti Sensei", 
        "Khaerul Sensei", 
        "Robbi Sensei", 
        "Rowi Sensei",
        "Singgih sensei Kelas karyawan",
        "rowi sensei Kelas karyawan"
      ];
    }

    // Jika Administrator, sertakan opsi "Absensi Staff & Sensei" (Full Online)
    if (currentUser && currentUser.role === "admin") {
      if (validSheets.indexOf(STAFF_SENSEI_SHEET) === -1) {
        validSheets.push(STAFF_SENSEI_SHEET);
      }
      return validSheets;
    }

    // Bila Sensei biasa, filter hanya ke sheet yang diizinkan untuknya (jangan pernah tampilkan Staff & Sensei)
    if (currentUser && currentUser.sheet && currentUser.sheet !== "ALL") {
      var userAllowed = getUserAllowedSheets(currentUser);
      if (userAllowed && userAllowed.length > 0) {
        var matched = validSheets.filter(function(vs) {
          return !isStaffSenseiSheet(vs) && isUserAllowedSheet(currentUser, vs);
        });
        return matched.length > 0 ? matched : userAllowed;
      }
      return [currentUser.sheet];
    }
    
    return validSheets.filter(function(vs) { return !isStaffSenseiSheet(vs); });
  } catch (err) {
    if (/Sesi berakhir/.test(String(err))) return [];
    var defaultList = [
      "Singgih Sensei", 
      "Esti Sensei", 
      "Khaerul Sensei", 
      "Robbi Sensei", 
      "Rowi Sensei",
      "Singgih sensei Kelas karyawan",
      "rowi sensei Kelas karyawan"
    ];
    if (currentUser && currentUser.role === "admin") {
      defaultList.push(STAFF_SENSEI_SHEET);
    }
    return defaultList;
  }
}

/**
 * Resolusi Sheet untuk Sensei & Bulan tertentu (mendukung sheet per bulan atau fallback sheet default)
 */
function getSheetForSensei(ss, senseiName, month, year) {
  if (!ss || !senseiName) return null;
  var now = new Date();
  var m = parseInt(month, 10) || (now.getMonth() + 1);
  var y = parseInt(year, 10) || now.getFullYear();
  var monthNames = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  var monthShort = ["", "Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  var mName = monthNames[m] || "";
  var mShort = monthShort[m] || "";

  var candidates = [
    senseiName + " - " + mName + " " + y,
    senseiName + " - " + mShort + " " + y,
    senseiName + " " + mName + " " + y,
    senseiName + " (" + mName + " " + y + ")",
    senseiName + " - " + mName,
    senseiName + " (" + mName + ")",
    senseiName + " " + mName,
    senseiName
  ];

  // 1. Coba getSheetByName langsung
  for (var i = 0; i < candidates.length; i++) {
    var s = ss.getSheetByName(candidates[i]);
    if (s) return s;
  }

  var sheets = ss.getSheets();
  var targetLower = senseiName.toLowerCase().trim();
  var isKaryawan = targetLower.indexOf("karyawan") !== -1;

  // 2. Exact match case-insensitive dengan candidates
  for (var c = 0; c < candidates.length; c++) {
    var candLower = candidates[c].toLowerCase().trim();
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getName().toLowerCase().trim() === candLower) {
        return sheets[i];
      }
    }
  }

  // 3. Exact match case-insensitive dengan senseiName
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().toLowerCase().trim() === targetLower) {
      return sheets[i];
    }
  }

  var cleanTargetSensei = targetLower.replace(/\s*sensei/i, '').replace(/\s*kelas\s*karyawan/i, '').trim();

  // 4. Cari sheet yang memuat nama sensei DAN nama bulan (membedakan karyawan vs reguler)
  for (var j = 0; j < sheets.length; j++) {
    var name = sheets[j].getName().toLowerCase().trim();
    if (name === "users" || name === "siswa_keluar" || name === "settings" || name.indexOf("rekap") !== -1) continue;
    
    var sheetIsKaryawan = name.indexOf("karyawan") !== -1;
    if (isKaryawan !== sheetIsKaryawan) continue;

    if ((name.indexOf(cleanTargetSensei) !== -1) && 
       (name.indexOf(mName.toLowerCase()) !== -1 || (mShort && name.indexOf(mShort.toLowerCase()) !== -1))) {
      return sheets[j];
    }
  }

  // 5. Fallback: cari sheet yang memuat nama sensei (membedakan karyawan vs reguler)
  for (var k = 0; k < sheets.length; k++) {
    var sName = sheets[k].getName().toLowerCase().trim();
    if (sName !== "users" && sName !== "siswa_keluar" && sName !== "settings" && sName.indexOf("rekap") === -1) {
      var sIsKaryawan = sName.indexOf("karyawan") !== -1;
      if (isKaryawan === sIsKaryawan && sName.indexOf(cleanTargetSensei) !== -1) {
        return sheets[k];
      }
    }
  }

  return ss.getSheetByName(senseiName);
}

/**
 * Memeriksa apakah sheet yang ditemukan benar-benar merupakan sheet untuk bulan & tahun yang diminta.
 * Mencegah data bulan lama (contoh Oktober) bocor ke bulan baru/mendatang (contoh November).
 */
function isSheetForMonth(sheet, senseiName, month, year) {
  if (!sheet) return false;
  var sName = sheet.getName().toLowerCase().trim();
  var m = parseInt(month, 10);
  var y = parseInt(year, 10);

  var monthNames = ["", "januari", "februari", "maret", "april", "mei", "juni", "juli", "agustus", "september", "oktober", "november", "desember"];
  var monthShort = ["", "jan", "feb", "mar", "apr", "mei", "jun", "jul", "agu", "sep", "okt", "nov", "des"];

  var reqName = monthNames[m] || "";
  var reqShort = monthShort[m] || "";

  // 1. Jika nama sheet secara eksplisit menyebut nama bulan lain
  for (var otherM = 1; otherM <= 12; otherM++) {
    if (otherM === m) continue;
    var oName = monthNames[otherM];
    var oShort = monthShort[otherM];
    if (sName.indexOf(oName) !== -1 || (oShort && sName.indexOf(oShort) !== -1)) {
      return false; // Sheet ini untuk bulan lain!
    }
  }

  // Jika nama sheet cocok dengan nama bulan yang diminta
  if ((reqName && sName.indexOf(reqName) !== -1) || (reqShort && sName.indexOf(reqShort) !== -1)) {
    return true;
  }

  // 2. Jika nama sheet netral (misal hanya "Esti Sensei"):
  // Periksa header sheet (baris 1 s/d 4) untuk melihat penanda bulan
  try {
    var checkRows = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 4), Math.min(sheet.getLastColumn(), 38)).getValues();
    for (var r = 0; r < checkRows.length; r++) {
      for (var c = 0; c < checkRows[r].length; c++) {
        var cell = checkRows[r][c];
        if (cell instanceof Date) {
          var cellM = cell.getMonth() + 1;
          if (cellM === m) return true;
          if (cellM !== m) return false;
        } else if (cell) {
          var str = cell.toString().toLowerCase().trim();
          for (var otherM = 1; otherM <= 12; otherM++) {
            if (otherM === m) continue;
            var oName = monthNames[otherM];
            if (str.indexOf(oName) !== -1) {
              return false; // Header berisi nama bulan lain!
            }
          }
          var matchSlash = str.match(/^(\d{1,2})\/(\d{1,2})/);
          if (matchSlash) {
            var firstNum = parseInt(matchSlash[1], 10);
            if (firstNum !== m && firstNum <= 12) {
              return false;
            }
          }
        }
      }
    }
  } catch(e) {}

  // 3. Jika sheet netral tanpa penanda bulan khusus:
  // Jika bulan yang diminta adalah bulan mendatang relatif thd sekarang, sheet lama bukan sheet bulan itu
  var now = new Date();
  var curM = now.getMonth() + 1;
  var curY = now.getFullYear();

  if (y > curY || (y === curY && m > curM)) {
    return false;
  }

  return true;
}

/**
 * Mendapatkan sheet bulanan atau membuat sheet baru secara otomatis jika belum ada saat menyimpan absen
 */
function getOrCreateMonthlySheet(ss, senseiName, month, year) {
  var existing = getSheetForSensei(ss, senseiName, month, year);
  if (existing && isSheetForMonth(existing, senseiName, month, year)) {
    return existing;
  }

  var baseSheet = existing || ss.getSheetByName(senseiName);
  var monthNames = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  var mName = monthNames[month] || ("Bulan " + month);
  var newSheetName = senseiName + " - " + mName + " " + year;

  var targetSheet = ss.getSheetByName(newSheetName);
  if (targetSheet) return targetSheet;

  if (baseSheet) {
    try {
      targetSheet = baseSheet.copyTo(ss);
      targetSheet.setName(newSheetName);

      var layout = getSheetColumnLayout(targetSheet, month, year);
      var lastRow = targetSheet.getLastRow();
      var lastCol = targetSheet.getLastColumn();

      if (lastRow >= layout.startStudentRow) {
        var numStudentRows = (layout.summaryRowIndex !== -1 ? layout.summaryRowIndex : (lastRow + 1)) - layout.startStudentRow;
        if (numStudentRows > 0) {
          var dateColsSpan = Math.min(31, lastCol - layout.dateStartCol + 1);
          var dateRange = targetSheet.getRange(layout.startStudentRow, layout.dateStartCol, numStudentRows, dateColsSpan);
          dateRange.clearContent();
          dateRange.clearNote();
        }
      }

      return targetSheet;
    } catch(copyErr) {
      return baseSheet;
    }
  }

  return ss.getSheetByName(senseiName);
}

/**
 * Deteksi tata letak kolom sheet secara dinamis dan akurat:
 * - dateStartCol: Kolom tanggal 1 (biasanya D = 4 atau C = 3)
 * - nameCol: Kolom nama siswa
 * - noCol: Kolom nomor urut
 * - startStudentRow: Baris awal siswa (4 atau 5)
 * - summaryRowIndex: Baris summary "Total Hadir Pertanggal" / "Rekap"
 */
function getSheetColumnLayout(sheet, month, year) {
  var lastCol = sheet.getLastColumn() || 40;
  var lastRow = sheet.getLastRow() || 50;
  var m = parseInt(month, 10) || (new Date().getMonth() + 1);

  var maxHeaderCol = Math.min(lastCol, 38);
  var headerRows = [
    sheet.getRange(2, 1, 1, maxHeaderCol).getValues()[0],
    sheet.getRange(3, 1, 1, maxHeaderCol).getValues()[0],
    sheet.getRange(4, 1, 1, maxHeaderCol).getValues()[0]
  ];

  var dateStartCol = 4; // Default Kolom D
  var detectedDateCol = -1;
  var monthRegex = new RegExp("^" + m + "\\/1($|\\s)", "i");

  for (var c = 1; c < maxHeaderCol; c++) {
    for (var hr = 0; hr < headerRows.length; hr++) {
      var v = (headerRows[hr][c] || "").toString().trim();
      if (monthRegex.test(v) || /^\d+\/1($|\s)/i.test(v) || v === "1" || /^(thu|kamis|mon|senin|tue|sel|wed|rab|fri|jum|sat|sab|sun|min)/i.test(v)) {
        detectedDateCol = c + 1; // 1-based index
        break;
      }
    }
    if (detectedDateCol !== -1) break;
  }
  if (detectedDateCol !== -1) {
    dateStartCol = detectedDateCol;
  }

  var preDateCols = Math.max(1, dateStartCol - 1);
  var nameCol = preDateCols;
  var noCol = 1;

  for (var c = 1; c <= preDateCols; c++) {
    for (var hr = 0; hr < headerRows.length; hr++) {
      var hv = (headerRows[hr][c - 1] || "").toString().trim().toLowerCase();
      if (hv === "nama" || hv === "nama siswa" || hv === "nama lengkap" || hv.indexOf("nama") !== -1) {
        nameCol = c;
      }
      if (hv === "no" || hv === "no." || hv === "nomor" || hv === "no urut") {
        noCol = c;
      }
    }
  }

  var startStudentRow = 5;
  var row4Val = sheet.getRange(4, 1, 1, Math.min(lastCol, 5)).getValues()[0].join(" ").toLowerCase();
  if (row4Val.indexOf("nama") === -1 && row4Val.indexOf("no") === -1 && row4Val.indexOf("nis") === -1) {
    startStudentRow = 4;
  }

  // Verifikasi dan sampling data baris siswa
  var sampleRowsCount = Math.min(lastRow - startStudentRow + 1, 10);
  if (sampleRowsCount > 0) {
    var sampleData = sheet.getRange(startStudentRow, 1, sampleRowsCount, preDateCols).getValues();
    var nameScores = {};
    var numberScores = {};
    for (var c = 1; c <= preDateCols; c++) {
      nameScores[c] = 0;
      numberScores[c] = 0;
    }
    for (var sr = 0; sr < sampleData.length; sr++) {
      var rowSample = sampleData[sr];
      for (var c = 1; c <= preDateCols; c++) {
        var valStr = (rowSample[c - 1] || "").toString().trim();
        if (!valStr) continue;
        if (/^\d+$/.test(valStr)) {
          numberScores[c]++;
        } else if (/[a-zA-Z]/.test(valStr) && valStr.length >= 3 && 
                   valStr.toLowerCase().indexOf("total") === -1 && 
                   valStr.toLowerCase().indexOf("pertanggal") === -1 &&
                   valStr.toLowerCase().indexOf("rekap") === -1) {
          nameScores[c] += 2;
        }
      }
    }

    var bestNameCol = nameCol;
    var maxNameScore = 0;
    for (var c = 1; c <= preDateCols; c++) {
      if (nameScores[c] > maxNameScore) {
        maxNameScore = nameScores[c];
        bestNameCol = c;
      }
    }
    if (maxNameScore > 0) nameCol = bestNameCol;

    var bestNoCol = noCol;
    var maxNoScore = 0;
    for (var c = 1; c <= preDateCols; c++) {
      if (c !== nameCol && numberScores[c] > maxNoScore) {
        maxNoScore = numberScores[c];
        bestNoCol = c;
      }
    }
    if (maxNoScore > 0) noCol = bestNoCol;
  }

  // Scan baris summary Total Hadir / Rekap
  var summaryRowIndex = -1;
  if (lastRow >= startStudentRow) {
    var scanCount = lastRow - startStudentRow + 1;
    var scanData = sheet.getRange(startStudentRow, 1, scanCount, Math.min(lastCol, 5)).getValues();
    for (var sr = 0; sr < scanData.length; sr++) {
      var rowStr = scanData[sr].join(" ").toLowerCase();
      if (rowStr.indexOf("total") !== -1 || rowStr.indexOf("pertanggal") !== -1 || rowStr.indexOf("rekap") !== -1 || rowStr.indexOf("jumlah") !== -1) {
        summaryRowIndex = startStudentRow + sr;
        break;
      }
    }
  }

  return {
    dateStartCol: dateStartCol,
    nameCol: nameCol,
    noCol: noCol,
    startStudentRow: startStudentRow,
    summaryRowIndex: summaryRowIndex
  };
}

/**
 * Mencari nomor baris siswa di sheet secara presisi
 * Mengabaikan status presensi (H/S/I/A/L) dan angka nomor urut
 */
function findStudentRowInSheet(sheet, studentName, rowIndex, dateStartCol) {
  if (!sheet) return -1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 4) return -1;

  var target = cleanStudentName(studentName).toLowerCase().trim();
  if (!target || target.length < 2) return -1;

  var checkColLimit = Math.max(3, (dateStartCol ? dateStartCol - 1 : 3));

  // 1. Cek di rowIndex terlebih dahulu jika diberikan
  if (rowIndex && rowIndex >= 4 && rowIndex <= lastRow) {
    var rowVals = sheet.getRange(rowIndex, 1, 1, Math.min(sheet.getLastColumn(), Math.max(checkColLimit, 5))).getValues()[0];
    for (var c = 0; c < rowVals.length; c++) {
      var cellRaw = (rowVals[c] || "").toString().trim();
      if (!cellRaw) continue;
      if (/^[HSIAL]$/i.test(cellRaw) || /^\d+$/.test(cellRaw)) continue;

      var val = cleanStudentName(cellRaw).toLowerCase().trim();
      if (val === target) {
        return rowIndex;
      }
      if (val.length >= 4 && target.length >= 4 && (val.indexOf(target) !== -1 || target.indexOf(val) !== -1)) {
        return rowIndex;
      }
    }
  }

  // 2. Scan seluruh baris siswa dari baris 4 sampai lastRow
  var totalRows = lastRow - 3;
  var allData = sheet.getRange(4, 1, totalRows, Math.min(sheet.getLastColumn(), Math.max(checkColLimit, 5))).getValues();
  for (var r = 0; r < allData.length; r++) {
    var rRow = allData[r];
    for (var c = 0; c < rRow.length; c++) {
      var cellRaw = (rRow[c] || "").toString().trim();
      if (!cellRaw) continue;
      if (/^[HSIAL]$/i.test(cellRaw) || /^\d+$/.test(cellRaw)) continue;

      var val = cleanStudentName(cellRaw).toLowerCase().trim();
      if (val === target) {
        return 4 + r;
      }
      if (val.length >= 4 && target.length >= 4 && (val.indexOf(target) !== -1 || target.indexOf(val) !== -1)) {
        return 4 + r;
      }
    }
  }

  return -1;
}

/**
 * Mengambil data absensi Staff & Sensei (Mode FULL ONLINE - ScriptProperties, TIDAK menambah sheet di spreadsheet)
 */
function getStaffSenseiAttendanceData(month, year) {
  var now = new Date();
  var m = parseInt(month, 10) || (now.getMonth() + 1);
  var y = parseInt(year, 10) || now.getFullYear();
  var key = "STAFF_ATTENDANCE_" + y + "_" + m;

  var records = null;
  try {
    var props = PropertiesService.getScriptProperties();
    var rawJson = props.getProperty(key);
    if (rawJson) {
      records = JSON.parse(rawJson);
    }
  } catch (e) {}

  if (!records || !Array.isArray(records) || records.length === 0) {
    records = DEFAULT_STAFF_SENSEI_NAMES.map(function(nama, index) {
      return {
        rowIndex: index + 1,
        no: index + 1,
        nama: nama,
        attendance: {},
        notes: {}
      };
    });
  }

  return {
    success: true,
    sensei: STAFF_SENSEI_SHEET,
    month: m,
    year: y,
    isOnlineOnly: true,
    dateStartCol: 4,
    students: records,
    totalHadirPertanggal: {}
  };
}

/**
 * Menyimpan data absensi Staff & Sensei (Mode FULL ONLINE - ScriptProperties)
 */
function saveStaffSenseiAttendance(dayTanggal, attendanceUpdates, month, year) {
  var now = new Date();
  var m = parseInt(month, 10) || (now.getMonth() + 1);
  var y = parseInt(year, 10) || now.getFullYear();
  var key = "STAFF_ATTENDANCE_" + y + "_" + m;

  var currentResult = getStaffSenseiAttendanceData(m, y);
  var currentData = currentResult.students;
  var dayStr = String(parseInt(dayTanggal, 10));

  attendanceUpdates.forEach(function(item, idx) {
    var target = null;
    if (item.rowIndex) {
      target = currentData.find(function(s) { return s.rowIndex === item.rowIndex; });
    }
    if (!target && idx < currentData.length) {
      target = currentData[idx];
    }
    if (target) {
      if (!target.attendance) target.attendance = {};
      if (!target.notes) target.notes = {};
      target.attendance[dayStr] = (item.status || "").toString().toUpperCase().trim();
      target.notes[dayStr] = (item.note || "").toString().trim();
    }
  });

  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty(key, JSON.stringify(currentData));
  } catch (e) {
    return { success: false, message: "Gagal menyimpan online: " + e.toString() };
  }

  return {
    success: true,
    message: "Absensi Staff & Sensei tgl " + dayTanggal + " (" + m + "/" + y + ") tersimpan ONLINE!"
  };
}

/**
 * Membaca data presensi (DENGAN FILTER TOTAL HADIR PERTANGGAL & PARSING NAMA BERSIH)
 */
function getAttendanceData(senseiName, month, year, currentUser) {
  try {
    currentUser = authUser(currentUser);
    if (isStaffSenseiSheet(senseiName)) {
      if (currentUser && currentUser.role !== 'admin') {
        return { success: false, message: "Akses Ditolak: Fitur Absensi Staff & Sensei khusus Administrator!" };
      }
      return getStaffSenseiAttendanceData(month, year);
    }

    if (currentUser && currentUser.role !== 'admin' && !isUserAllowedSheet(currentUser, senseiName)) {
      return { success: false, message: "Akses Ditolak: Anda tidak memiliki wewenang mengedit sheet " + senseiName };
    }

    var m = parseInt(month, 10) || (new Date().getMonth() + 1);
    var y = parseInt(year, 10) || new Date().getFullYear();

    var ss = getSS();
    if (!ss) return { success: false, message: "Spreadsheet tidak ditemukan." };

    var now = new Date();
    var curY = now.getFullYear();
    var curM = now.getMonth() + 1;
    var curD = now.getDate();

    var sheet = getSheetForSensei(ss, senseiName, m, y);
    if (!sheet) sheet = ss.getSheetByName(senseiName);
    
    if (!sheet) {
      return { success: false, message: "Sheet untuk " + senseiName + " tidak ditemukan." };
    }

    var sheetMatchesMonth = isSheetForMonth(sheet, senseiName, m, y);
    
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    
    if (lastRow < 4) {
      return { success: false, message: "Format sheet belum diinisialisasi." };
    }

    var layout = getSheetColumnLayout(sheet, m, y);
    var dateStartCol = layout.dateStartCol;
    var nameCol = layout.nameCol;
    var noCol = layout.noCol;
    var startStudentRow = layout.startStudentRow;

    var totalRowsToRead = lastRow - startStudentRow + 1;
    if (totalRowsToRead <= 0) {
      return { success: true, sensei: senseiName, month: m, year: y, students: [], totalHadirPertanggal: {} };
    }

    var rawData = sheet.getRange(startStudentRow, 1, totalRowsToRead, Math.max(lastCol, dateStartCol + 30)).getValues();
    var dateSpan = Math.min(31, Math.max(1, lastCol - dateStartCol + 1));
    var rawNotes = sheet.getRange(startStudentRow, dateStartCol, totalRowsToRead, dateSpan).getNotes();

    var students = [];
    var totalHadirPertanggal = {};

    for (var i = 0; i < rawData.length; i++) {
      var row = rawData[i];
      var currentRowIndex = startStudentRow + i;

      var rowStr = row.slice(0, Math.min(row.length, 5)).join(" ").toLowerCase();

      // CEK SUMMARY ROW: "Total hadir pertanggal", "Total Hadir", "Rekap", "Jumlah"
      if (rowStr.indexOf("total") !== -1 || 
          rowStr.indexOf("pertanggal") !== -1 || 
          rowStr.indexOf("rekap") !== -1 || 
          rowStr.indexOf("jumlah") !== -1) {
        
        if (sheetMatchesMonth) {
          for (var d = 1; d <= 31; d++) {
            var isFutureDay = (y > curY) || (y === curY && m > curM) || (y === curY && m === curM && d > curD);
            if (!isFutureDay) {
              var colIdx = dateStartCol - 1 + (d - 1);
              if (colIdx < row.length) {
                totalHadirPertanggal[d] = row[colIdx] || 0;
              }
            }
          }
        }
        continue; // JANGAN PERNAH MASUKKAN SEBAGAI SISWA!
      }

      var rawName = (row[nameCol - 1] !== undefined ? row[nameCol - 1].toString().trim() : "");
      var rawNo = (row[noCol - 1] !== undefined ? row[noCol - 1].toString().trim() : "");

      // Fallback jika rawName kosong tapi ada kolom lain sebelum dateStartCol yang berisi nama siswa
      if (!rawName || rawName.length < 2) {
        for (var c = 0; c < dateStartCol - 1; c++) {
          var cand = (row[c] || "").toString().trim();
          if (cand && /[a-zA-Z]/.test(cand) && cand.length >= 2 && !/^[HSIAL]$/i.test(cand)) {
            rawName = cand;
            break;
          }
        }
      }

      var no = null;
      var nama = "";

      var matchNumberPrefix = rawName.match(/^(\d+)[\.\s\-]+(.+)$/);
      if (matchNumberPrefix) {
        no = parseInt(matchNumberPrefix[1], 10);
        nama = matchNumberPrefix[2].trim();
      } else if (rawNo && /^\d+$/.test(rawNo)) {
        no = parseInt(rawNo, 10);
        nama = rawName;
      } else {
        nama = rawName;
        no = students.length + 1;
      }

      if (!nama || nama.length < 2 || /^[HSIAL]$/i.test(nama)) continue;

      var attendanceMap = {};
      var notesMap = {};

      for (var d = 1; d <= 31; d++) {
        var status = "";
        var note = "";

        // Tanggal ke depan / belum berlangsung harusnya belum ada data absennya
        var isFutureDay = (y > curY) || (y === curY && m > curM) || (y === curY && m === curM && d > curD);

        // Hanya baca dari sheet jika sheet ini memang benar milik bulan & tahun yang diminta
        // dan tanggal d bukan tanggal di masa depan
        if (sheetMatchesMonth && !isFutureDay) {
          var colIdx = dateStartCol - 1 + (d - 1);
          if (colIdx < row.length) {
            status = (row[colIdx] || "").toString().trim().toUpperCase();
          }
          if (rawNotes[i] && (d - 1) < rawNotes[i].length) {
            note = (rawNotes[i][d - 1] || "").toString().trim();
          }
        }

        attendanceMap[d] = status;
        notesMap[d] = note;
      }

      students.push({
        rowIndex: currentRowIndex,
        no: no || (students.length + 1),
        nama: nama,
        attendance: attendanceMap,
        notes: notesMap
      });
    }

    return {
      success: true,
      sensei: senseiName,
      month: m,
      year: y,
      dateStartCol: dateStartCol,
      students: students,
      totalHadirPertanggal: totalHadirPertanggal
    };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

/**
 * Menyimpan data presensi harian
 */
function _saveDailyAttendance(senseiName, dayTanggal, attendanceUpdates, currentUser, month, year) {
  try {
    currentUser = authUser(currentUser);
    if (isStaffSenseiSheet(senseiName)) {
      if (currentUser && currentUser.role !== 'admin') {
        return { success: false, message: "Akses Ditolak: Hanya Administrator yang berhak menyimpan absensi Staff & Sensei!" };
      }
      return saveStaffSenseiAttendance(dayTanggal, attendanceUpdates, month, year);
    }

    if (currentUser && currentUser.role !== 'admin' && !isUserAllowedSheet(currentUser, senseiName)) {
      return { success: false, message: "Akses Ditolak: Anda hanya boleh mengedit sheet kelas Anda sendiri." };
    }

    var m = parseInt(month, 10) || (new Date().getMonth() + 1);
    var y = parseInt(year, 10) || new Date().getFullYear();

    var ss = getSS();
    if (!ss) return { success: false, message: "Spreadsheet tidak ditemukan." };

    var sheet = getOrCreateMonthlySheet(ss, senseiName, m, y);
    if (!sheet) return { success: false, message: "Sheet " + senseiName + " tidak ditemukan." };
    
    var layout = getSheetColumnLayout(sheet, m, y);
    var dateStartCol = layout.dateStartCol;

    var dayInt = parseInt(dayTanggal, 10);
    var targetCol = dateStartCol + (dayInt - 1);
    var colKeterangan = dateStartCol + 35; // Kolom setelah summary Total (biasanya AM = 39 jika dateStartCol = 4)

    var countHadir = 0;
    var valid = attendanceUpdates.filter(function(i) { return i.rowIndex && i.status !== undefined; });
    if (valid.length) {
      var rows = valid.map(function(i) { return i.rowIndex; });
      var minR = Math.min.apply(null, rows), maxR = Math.max.apply(null, rows);
      var rng = sheet.getRange(minR, targetCol, maxR - minR + 1, 1);
      var vals = rng.getValues(), notes = rng.getNotes();
      valid.forEach(function(item) {
        var k = item.rowIndex - minR;
        var status = item.status.toString().toUpperCase().trim();
        var note = (item.note || "").toString().trim();
        vals[k][0] = status;
        if (status === 'H') countHadir++;
        if ((status === 'S' || status === 'I') && note !== "") {
          notes[k][0] = "Tgl " + dayTanggal + ": " + note;
          var ketCell = sheet.getRange(item.rowIndex, colKeterangan);
          var existingKet = ketCell.getValue() ? ketCell.getValue().toString() : "";
          if (existingKet.indexOf(m + "/" + dayTanggal) === -1) {
            var entry = m + "/" + dayTanggal + " (" + status + "): " + note;
            ketCell.setValue(existingKet ? (existingKet + " | " + entry) : entry);
          }
        } else {
          notes[k][0] = "";
        }
      });
      rng.setValues(vals);
      rng.setNotes(notes);
    }

    // Update row "Total hadir pertanggal" bila ada di spreadsheet
    if (layout.summaryRowIndex !== -1) {
      try {
        var totalCell = sheet.getRange(layout.summaryRowIndex, targetCol);
        var formula = totalCell.getFormula();
        if (!formula) {
          totalCell.setValue(countHadir);
        }
      } catch(e) {}
    }
    
    return { success: true, message: "Absen tanggal " + dayTanggal + " berhasil disimpan!" };
  } catch (err) {
    return { success: false, message: "Gagal menyimpan: " + err.toString() };
  }
}

/**
 * Mendapatkan daftar siswa yang belum ada di kelas manapun atau sudah di-kick
 */
function getAvailableStudents(currentUser, month, year) {
  try {
    currentUser = authUser(currentUser);
    var ss = getSS();
    if (!ss) return [];

    var now = new Date();
    var m = parseInt(month, 10) || (now.getMonth() + 1);
    var y = parseInt(year, 10) || now.getFullYear();

    var activeMap = {};
    var allSensei = getSenseiList({ role: 'admin' });

    for (var s = 0; s < allSensei.length; s++) {
      var sheet = getSheetForSensei(ss, allSensei[s], m, y);
      if (!sheet) sheet = ss.getSheetByName(allSensei[s]);
      if (!sheet) continue;

      var layout = getSheetColumnLayout(sheet, m, y);
      var lastR = sheet.getLastRow();
      if (lastR < layout.startStudentRow) continue;

      var numRows = lastR - layout.startStudentRow + 1;
      var raw = sheet.getRange(layout.startStudentRow, 1, numRows, Math.max(layout.nameCol, 3)).getValues();

      for (var r = 0; r < raw.length; r++) {
        var rowText = raw[r].join(" ").toLowerCase();
        if (rowText.indexOf("total") !== -1 || rowText.indexOf("pertanggal") !== -1 || rowText.indexOf("rekap") !== -1 || rowText.indexOf("jumlah") !== -1) continue;

        var nameVal = (raw[r][layout.nameCol - 1] || "").toString().trim();
        var name = cleanStudentName(nameVal);
        if (name && name.length >= 2 && !/^[HSIAL]$/i.test(name) && !/^\d+$/.test(name)) {
          activeMap[name.toLowerCase()] = allSensei[s];
        }
      }
    }

    var kickedSheet = ss.getSheetByName("Siswa_Keluar");
    var list = [];
    if (kickedSheet && kickedSheet.getLastRow() > 1) {
      var numCols = Math.max(8, kickedSheet.getLastColumn());
      var rows = kickedSheet.getRange(2, 1, kickedSheet.getLastRow() - 1, numCols).getValues();
      for (var i = rows.length - 1; i >= 0; i--) {
        var stName = (rows[i][1] || "").toString().trim();
        var fromSensei = (rows[i][2] || "").toString().trim();
        var status = (rows[i][4] || "Tersedia").toString().trim();
        var keterangan = (rows[i][5] || "").toString().trim();
        var kategori = (rows[i][6] || "").toString().trim();

        // Jangan rekomendasikan siswa berstatus Blacklist
        var isBlacklist = status.toLowerCase().indexOf("permanen") !== -1 && 
          (kategori.toLowerCase().indexOf("blacklist") !== -1 || kategori.toLowerCase().indexOf("tolak") !== -1 || kategori.toLowerCase().indexOf("tidak") !== -1);
        if (isBlacklist) continue;

        if (stName && !activeMap[stName.toLowerCase()]) {
          var alreadyAdded = list.some(function(item) {
            return item.nama.toLowerCase() === stName.toLowerCase();
          });
          if (!alreadyAdded) {
            list.push({
              nama: stName,
              fromSensei: fromSensei,
              status: status,
              keterangan: keterangan,
              kategori: kategori
            });
          }
        }
      }
    }

    return list;
  } catch (err) {
    if (/Sesi berakhir/.test(String(err))) throw err;
    return [];
  }
}

/**
 * Menambahkan siswa baru
 * ATURAN: Siswa hanya bisa ditambahkan jika belum ada di kelas manapun atau sudah di-kick dari kelas lain.
 * Admin memiliki wewenang untuk menambahkan siswa ke kelas manapun.
 */
function _addStudent(senseiName, namaSiswa, currentUser, month, year) {
  try {
    currentUser = authUser(currentUser);
    if (isStaffSenseiSheet(senseiName)) {
      return { success: false, message: "Sheet Staff & Sensei bersifat khusus dan full online!" };
    }

    if (currentUser && currentUser.role !== 'admin' && !isUserAllowedSheet(currentUser, senseiName)) {
      return { success: false, message: "Akses Ditolak: Anda hanya boleh mengedit kelas Anda sendiri!" };
    }

    namaSiswa = (namaSiswa || "").toString().trim().toUpperCase();
    if (!namaSiswa || namaSiswa.length < 2) {
      return { success: false, message: "Nama siswa minimal 2 karakter!" };
    }

    var ss = getSS();
    if (!ss) return { success: false, message: "Spreadsheet tidak ditemukan" };

    var now = new Date();
    var m = parseInt(month, 10) || (now.getMonth() + 1);
    var y = parseInt(year, 10) || now.getFullYear();

    var targetSheet = getSheetForSensei(ss, senseiName, m, y);
    if (!targetSheet) targetSheet = ss.getSheetByName(senseiName);
    if (!targetSheet) return { success: false, message: "Sheet untuk " + senseiName + " tidak ditemukan." };

    var normalizedTarget = cleanStudentName(namaSiswa).toLowerCase();
    var layout = getSheetColumnLayout(targetSheet, m, y);

    // 1. Cek apakah siswa sudah ada di kelas target
    var existingRowInTarget = findStudentRowInSheet(targetSheet, normalizedTarget, null, layout.dateStartCol);
    if (existingRowInTarget !== -1) {
      return { success: false, message: "Siswa " + namaSiswa + " sudah terdaftar di kelas " + senseiName + "!" };
    }

    // 2. Cek apakah siswa aktif di kelas lain atau berstatus Blacklist
    var isKickedOrFree = false;
    var kickedSheet = ss.getSheetByName("Siswa_Keluar");
    if (kickedSheet && kickedSheet.getLastRow() > 1) {
      var numCols = Math.max(8, kickedSheet.getLastColumn());
      var kRows = kickedSheet.getRange(2, 1, kickedSheet.getLastRow() - 1, numCols).getValues();
      for (var k = kRows.length - 1; k >= 0; k--) {
        var kName = cleanStudentName(kRows[k][1]).toLowerCase();
        var kStatus = (kRows[k][4] || "").toString().toLowerCase();
        var kKategori = (kRows[k][6] || "").toString().toLowerCase();
        var kKeterangan = (kRows[k][5] || "").toString().trim();

        if (kName === normalizedTarget) {
          // CEK STATUS KELUAR PERMANEN - BLACKLIST / DITOLAK
          if (kStatus.indexOf("permanen") !== -1 && (kKategori.indexOf("blacklist") !== -1 || kKategori.indexOf("tolak") !== -1 || kKategori.indexOf("tidak") !== -1)) {
            return {
              success: false,
              message: "PENDAFTARAN DITOLAK: Siswa " + namaSiswa + " berstatus KELUAR PERMANEN (BLACKLIST - TIDAK DAPAT DITERIMA LAGI)! Alasan di-kick: " + (kKeterangan || "Pelanggaran disiplin")
            };
          }
          if (kStatus.indexOf("tersedia") !== -1 || kStatus.indexOf("bebas") !== -1 || (kStatus.indexOf("permanen") !== -1 && kKategori.indexOf("terima") !== -1)) {
            isKickedOrFree = true;
            break;
          }
        }
      }
    }

    var isAdmin = currentUser && currentUser.role === 'admin';
    if (!isAdmin && !isKickedOrFree) {
      var allSensei = getSenseiList({ role: 'admin' });
      for (var s = 0; s < allSensei.length; s++) {
        var checkSensei = allSensei[s];
        if (checkSensei === senseiName) continue;

        var cSheet = getSheetForSensei(ss, checkSensei, m, y);
        if (!cSheet) cSheet = ss.getSheetByName(checkSensei);
        if (!cSheet) continue;

        var cLayout = getSheetColumnLayout(cSheet, m, y);
        var foundRow = findStudentRowInSheet(cSheet, normalizedTarget, null, cLayout.dateStartCol);
        if (foundRow !== -1) {
          return {
            success: false,
            message: "Gagal: Siswa " + namaSiswa + " saat ini masih aktif di kelas " + checkSensei + "! Siswa hanya bisa ditambahkan jika sudah di-kick dari kelas tersebut atau dipindahkan oleh Admin."
          };
        }
      }
    }

    // 3. Tambahkan ke targetSheet sebelum baris Total Hadir / Summary
    var lastRow = targetSheet.getLastRow();
    var insertRow = layout.summaryRowIndex !== -1 ? layout.summaryRowIndex : (lastRow + 1);

    targetSheet.insertRowBefore(insertRow);

    // Hitung nomor urut baru
    var prevNo = targetSheet.getRange(insertRow - 1, layout.noCol).getValue();
    var newNo = 1;
    if (typeof prevNo === 'number' && !isNaN(prevNo)) {
      newNo = prevNo + 1;
    } else if (prevNo && /^\d+$/.test(prevNo.toString().trim())) {
      newNo = parseInt(prevNo.toString().trim(), 10) + 1;
    } else {
      newNo = Math.max(1, insertRow - layout.startStudentRow + 1);
    }

    targetSheet.getRange(insertRow, layout.noCol).setValue(newNo);
    if (layout.noCol === 2) {
      var col1Prev = targetSheet.getRange(insertRow - 1, 1).getValue();
      if (typeof col1Prev === 'number' && !isNaN(col1Prev)) {
        targetSheet.getRange(insertRow, 1).setValue(col1Prev + 1);
      } else if (col1Prev && /^\d+$/.test(col1Prev.toString().trim())) {
        targetSheet.getRange(insertRow, 1).setValue(parseInt(col1Prev.toString().trim(), 10) + 1);
      }
    }

    targetSheet.getRange(insertRow, layout.nameCol).setValue(namaSiswa);

    // Rumus Rekap Bulanan
    var dStartLetter = colToLetter(layout.dateStartCol);
    var dEndLetter = colToLetter(layout.dateStartCol + 30);
    var colH = layout.dateStartCol + 31;
    var colS = layout.dateStartCol + 32;
    var colI = layout.dateStartCol + 33;
    var colA = layout.dateStartCol + 34;
    var colTot = layout.dateStartCol + 35;

    targetSheet.getRange(insertRow, colH).setFormula('=COUNTIF(' + dStartLetter + insertRow + ':' + dEndLetter + insertRow + ', "H")');
    targetSheet.getRange(insertRow, colS).setFormula('=COUNTIF(' + dStartLetter + insertRow + ':' + dEndLetter + insertRow + ', "S")');
    targetSheet.getRange(insertRow, colI).setFormula('=COUNTIF(' + dStartLetter + insertRow + ':' + dEndLetter + insertRow + ', "I")');
    targetSheet.getRange(insertRow, colA).setFormula('=COUNTIF(' + dStartLetter + insertRow + ':' + dEndLetter + insertRow + ', "A")');
    targetSheet.getRange(insertRow, colTot).setFormula('=' + colToLetter(colH) + insertRow + '+' + colToLetter(colS) + insertRow + '+' + colToLetter(colI) + insertRow + '+' + colToLetter(colA) + insertRow);

    // 4. Update status di Siswa_Keluar jika ada
    try {
      if (kickedSheet && kickedSheet.getLastRow() > 1) {
        var kRows = kickedSheet.getRange(2, 1, kickedSheet.getLastRow() - 1, 5).getValues();
        for (var k = 0; k < kRows.length; k++) {
          if (cleanStudentName(kRows[k][1]).toLowerCase() === normalizedTarget) {
            kickedSheet.getRange(k + 2, 5).setValue("Aktif di " + senseiName);
          }
        }
      }
    } catch(e) {}

    return { 
      success: true, 
      message: "Siswa " + namaSiswa + " berhasil ditambahkan ke kelas " + senseiName + "!",
      insertRow: insertRow 
    };
  } catch (err) {
    return { success: false, message: "Gagal menambah siswa: " + err.toString() };
  }
}

/**
 * Mengeluarkan / Meng-kick siswa dari daftar presensi kelas
 * Dapat dilakukan oleh Sensei (hanya kelas miliknya) maupun Admin
 */
function _kickStudent(senseiName, studentName, rowIndex, currentUser, month, year, reason) {
  try {
    currentUser = authUser(currentUser);
    if (isStaffSenseiSheet(senseiName)) {
      return { success: false, message: "Fitur Kick tidak berlaku untuk Staff & Sensei!" };
    }

    if (currentUser && currentUser.role !== 'admin' && !isUserAllowedSheet(currentUser, senseiName)) {
      return { success: false, message: "Akses Ditolak: Anda hanya boleh mengedit kelas Anda sendiri!" };
    }

    var ss = getSS();
    if (!ss) return { success: false, message: "Spreadsheet tidak ditemukan." };

    var now = new Date();
    var m = parseInt(month, 10) || (now.getMonth() + 1);
    var y = parseInt(year, 10) || now.getFullYear();

    var sheet = getSheetForSensei(ss, senseiName, m, y);
    if (!sheet) sheet = ss.getSheetByName(senseiName);
    if (!sheet) return { success: false, message: "Sheet " + senseiName + " tidak ditemukan." };

    var layout = getSheetColumnLayout(sheet, m, y);
    var targetRow = findStudentRowInSheet(sheet, studentName, rowIndex, layout.dateStartCol);

    if (targetRow === -1) {
      return { success: false, message: "Siswa " + studentName + " tidak ditemukan di sheet " + senseiName + "." };
    }

    var kickReason = (reason || "").toString().trim() || "Tidak ada keterangan";

    // =====================================================================
    // SALIN RIWAYAT ABSENSI SEBELUM DIHAPUS (Agar history tetap tersimpan)
    // =====================================================================
    var attendanceHistoryJson = "";
    try {
      var lastColSheet = Math.max(sheet.getLastColumn(), layout.dateStartCol + 31);
      var rowValues = sheet.getRange(targetRow, 1, 1, lastColSheet).getValues()[0];
      var rowNotes = sheet.getRange(targetRow, 1, 1, lastColSheet).getNotes()[0];
      var daysInMonth = new Date(y, m, 0).getDate();

      var historyObj = {
        bulan: m,
        tahun: y,
        kelas: senseiName,
        attendance: {},
        notes: {}
      };

      for (var d = 0; d < daysInMonth; d++) {
        var colIdx = (layout.dateStartCol - 1) + d; // 0-based index into rowValues
        var dayNum = d + 1;
        if (colIdx < rowValues.length) {
          var val = (rowValues[colIdx] || "").toString().trim().toUpperCase();
          if (val === "H" || val === "S" || val === "I" || val === "A" || val === "L") {
            historyObj.attendance[dayNum] = val;
          }
          var note = (rowNotes[colIdx] || "").toString().trim();
          if (note) {
            historyObj.notes[dayNum] = note;
          }
        }
      }

      attendanceHistoryJson = JSON.stringify(historyObj);
    } catch(histErr) {
      // Jika gagal menyalin absensi, tetap lanjutkan proses kick
      attendanceHistoryJson = "";
    }

    // Catat ke sheet Siswa_Keluar (termasuk history absensi di kolom 9)
    try {
      var kickedSheet = getKickedSheet(ss);
      var timeStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+7", "yyyy-MM-dd HH:mm:ss");
      var kicker = (currentUser && currentUser.name) ? currentUser.name : (currentUser && currentUser.username ? currentUser.username : "User");
      kickedSheet.appendRow([timeStr, studentName, senseiName, kicker, "Tersedia (Bebas)", kickReason, "-", "-", attendanceHistoryJson]);
    } catch(e) {}

    // Hapus baris siswa dari sheet kelas
    sheet.deleteRow(targetRow);

    return { 
      success: true, 
      message: "Siswa " + studentName + " berhasil dikeluarkan (di-kick) dari kelas " + senseiName + "!" 
    };
  } catch (err) {
    return { success: false, message: "Gagal mengeluarkan siswa: " + err.toString() };
  }
}

/**
 * Memindahkan siswa antar kelas (FITUR KHUSUS ADMIN)
 * Contoh: Memindahkan siswa dari Esti Sensei ke Singgih Sensei
 */
function _transferStudent(fromSensei, toSensei, studentName, rowIndex, copyAttendance, month, year, currentUser) {
  try {
    currentUser = authUser(currentUser);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, message: "Akses Ditolak: Hanya Admin yang berhak memindahkan siswa antar kelas!" };
    }

    if (isStaffSenseiSheet(fromSensei) || isStaffSenseiSheet(toSensei)) {
      return { success: false, message: "Fitur Pindah Kelas tidak berlaku untuk Staff & Sensei!" };
    }

    if (!fromSensei || !toSensei || fromSensei === toSensei) {
      return { success: false, message: "Kelas asal dan kelas tujuan tidak boleh sama." };
    }

    var ss = getSS();
    if (!ss) return { success: false, message: "Spreadsheet tidak ditemukan." };

    var now = new Date();
    var m = parseInt(month, 10) || (now.getMonth() + 1);
    var y = parseInt(year, 10) || now.getFullYear();

    var fromSheet = getSheetForSensei(ss, fromSensei, m, y);
    if (!fromSheet) fromSheet = ss.getSheetByName(fromSensei);

    var toSheet = getSheetForSensei(ss, toSensei, m, y);
    if (!toSheet) toSheet = ss.getSheetByName(toSensei);

    if (!fromSheet) return { success: false, message: "Sheet asal " + fromSensei + " tidak ditemukan." };
    if (!toSheet) return { success: false, message: "Sheet tujuan " + toSensei + " tidak ditemukan." };

    var fromLayout = getSheetColumnLayout(fromSheet, m, y);
    var toLayout = getSheetColumnLayout(toSheet, m, y);

    // 1. Temukan baris siswa di fromSheet
    var sourceRow = findStudentRowInSheet(fromSheet, studentName, rowIndex, fromLayout.dateStartCol);

    if (sourceRow === -1) {
      return { success: false, message: "Siswa " + studentName + " tidak ditemukan di " + fromSensei + "." };
    }

    // 2. Ambil data siswa dari fromSheet (absensi & notes)
    var lastColFrom = fromSheet.getLastColumn();
    var studentValues = fromSheet.getRange(sourceRow, 1, 1, Math.max(lastColFrom, 39)).getValues()[0];
    var studentNotes = fromSheet.getRange(sourceRow, 1, 1, Math.max(lastColFrom, 39)).getNotes()[0];

    // 3. Tentukan baris insert di toSheet (sebelum Total Hadir / Summary)
    var lastRowTo = toSheet.getLastRow();
    var insertRow = toLayout.summaryRowIndex !== -1 ? toLayout.summaryRowIndex : (lastRowTo + 1);

    toSheet.insertRowBefore(insertRow);

    // Hitung nomor urut baru di toSheet
    var prevNo = toSheet.getRange(insertRow - 1, toLayout.noCol).getValue();
    var newNo = 1;
    if (typeof prevNo === 'number' && !isNaN(prevNo)) {
      newNo = prevNo + 1;
    } else if (prevNo && /^\d+$/.test(prevNo.toString().trim())) {
      newNo = parseInt(prevNo.toString().trim(), 10) + 1;
    } else {
      newNo = Math.max(1, insertRow - toLayout.startStudentRow + 1);
    }

    toSheet.getRange(insertRow, toLayout.noCol).setValue(newNo);
    if (toLayout.noCol === 2) {
      var col1Prev = toSheet.getRange(insertRow - 1, 1).getValue();
      if (typeof col1Prev === 'number' && !isNaN(col1Prev)) {
        toSheet.getRange(insertRow, 1).setValue(col1Prev + 1);
      } else if (col1Prev && /^\d+$/.test(col1Prev.toString().trim())) {
        toSheet.getRange(insertRow, 1).setValue(parseInt(col1Prev.toString().trim(), 10) + 1);
      }
    }

    toSheet.getRange(insertRow, toLayout.nameCol).setValue(studentName);

    // Rumus Rekap di toSheet
    var dStartLetter = colToLetter(toLayout.dateStartCol);
    var dEndLetter = colToLetter(toLayout.dateStartCol + 30);
    var colH = toLayout.dateStartCol + 31;
    var colS = toLayout.dateStartCol + 32;
    var colI = toLayout.dateStartCol + 33;
    var colA = toLayout.dateStartCol + 34;
    var colTot = toLayout.dateStartCol + 35;

    toSheet.getRange(insertRow, colH).setFormula('=COUNTIF(' + dStartLetter + insertRow + ':' + dEndLetter + insertRow + ', "H")');
    toSheet.getRange(insertRow, colS).setFormula('=COUNTIF(' + dStartLetter + insertRow + ':' + dEndLetter + insertRow + ', "S")');
    toSheet.getRange(insertRow, colI).setFormula('=COUNTIF(' + dStartLetter + insertRow + ':' + dEndLetter + insertRow + ', "I")');
    toSheet.getRange(insertRow, colA).setFormula('=COUNTIF(' + dStartLetter + insertRow + ':' + dEndLetter + insertRow + ', "A")');
    toSheet.getRange(insertRow, colTot).setFormula('=' + colToLetter(colH) + insertRow + '+' + colToLetter(colS) + insertRow + '+' + colToLetter(colI) + insertRow + '+' + colToLetter(colA) + insertRow);

    // 4. Jika copyAttendance = true, salin data absensi tgl 1-31
    if (copyAttendance) {
      var attVals = [];
      var attNotes = [];
      for (var d = 0; d < 31; d++) {
        var fromIdx = (fromLayout.dateStartCol - 1) + d;
        attVals.push(fromIdx < studentValues.length ? (studentValues[fromIdx] || "") : "");
        attNotes.push(fromIdx < studentNotes.length ? (studentNotes[fromIdx] || "") : "");
      }
      toSheet.getRange(insertRow, toLayout.dateStartCol, 1, 31).setValues([attVals]);
      toSheet.getRange(insertRow, toLayout.dateStartCol, 1, 31).setNotes([attNotes]);
    }

    // 5. Hapus siswa dari fromSheet
    fromSheet.deleteRow(sourceRow);

    // 6. Catat log pemindahan
    try {
      var kickedSheet = getKickedSheet(ss);
      var timeStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+7", "yyyy-MM-dd HH:mm:ss");
      var adminKicker = (currentUser && currentUser.name) ? currentUser.name : "Admin";
      kickedSheet.appendRow([timeStr, studentName, fromSensei, "Admin (" + adminKicker + ")", "Aktif di " + toSensei, "Dipindahkan oleh Admin", "-", "-"]);
    } catch(e) {}

    return {
      success: true,
      message: "Siswa " + studentName + " berhasil dipindahkan dari " + fromSensei + " ke " + toSensei + "!"
    };
  } catch (err) {
    return { success: false, message: "Gagal memindahkan siswa: " + err.toString() };
  }
}

/**
 * =========================================================================
 * FITUR KHUSUS ADMINISTRATOR: MANAJEMEN SISWA KELUAR & KELUAR PERMANEN
 * =========================================================================
 */

/**
 * Mengambil seluruh data riwayat siswa keluar / di-kick (KHUSUS ADMINISTRATOR)
 */
function getAllKickedStudents(currentUser, filterMonth, filterYear) {
  try {
    currentUser = authUser(currentUser);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, message: "Akses Ditolak: Fitur ini khusus Administrator!" };
    }

    var ss = getSS();
    if (!ss) return { success: false, message: "Spreadsheet tidak ditemukan." };

    var kickedSheet = getKickedSheet(ss);
    var lastRow = kickedSheet.getLastRow();
    if (lastRow < 2) {
      return {
        success: true,
        data: [],
        stats: { total: 0, tersedia: 0, permanenTerima: 0, permanenBlacklist: 0, aktif: 0 }
      };
    }

    var numCols = Math.max(9, kickedSheet.getLastColumn());
    var raw = kickedSheet.getRange(2, 1, lastRow - 1, numCols).getValues();

    var list = [];
    var stats = { total: 0, tersedia: 0, permanenTerima: 0, permanenBlacklist: 0, aktif: 0 };

    for (var i = raw.length - 1; i >= 0; i--) {
      var row = raw[i];
      var tglRaw = row[0];
      var timeStr = "";
      var itemMonth = null;
      var itemYear = null;

      if (tglRaw instanceof Date) {
        timeStr = Utilities.formatDate(tglRaw, Session.getScriptTimeZone() || "GMT+7", "yyyy-MM-dd HH:mm:ss");
        itemMonth = tglRaw.getMonth() + 1;
        itemYear = tglRaw.getFullYear();
      } else if (tglRaw) {
        timeStr = tglRaw.toString().trim();
        var match = timeStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (match) {
          itemYear = parseInt(match[1], 10);
          itemMonth = parseInt(match[2], 10);
        }
      }

      var nama = cleanStudentName(row[1]);
      if (!nama) continue;

      var kelasAsal = (row[2] || "").toString().trim();
      var kicker = (row[3] || "").toString().trim();
      var status = (row[4] || "Tersedia (Bebas)").toString().trim();
      var keterangan = (row[5] || "").toString().trim();
      var kategori = (row[6] || "").toString().trim();
      var catatanAdmin = (row[7] || "").toString().trim();

      var statusLower = status.toLowerCase();
      var kategoriLower = kategori.toLowerCase();

      var isPermanen = statusLower.indexOf("permanen") !== -1;
      var isBlacklist = isPermanen && (kategoriLower.indexOf("blacklist") !== -1 || kategoriLower.indexOf("tolak") !== -1 || kategoriLower.indexOf("tidak") !== -1);
      var isTerima = isPermanen && !isBlacklist;
      var isTersedia = statusLower.indexOf("tersedia") !== -1 || statusLower.indexOf("bebas") !== -1;
      var isAktif = statusLower.indexOf("aktif") !== -1;

      stats.total++;
      if (isBlacklist) stats.permanenBlacklist++;
      else if (isTerima) stats.permanenTerima++;
      else if (isTersedia) stats.tersedia++;
      else if (isAktif) stats.aktif++;

      // Filter bulanan jika diminta
      if (filterMonth && filterMonth !== "all") {
        var reqM = parseInt(filterMonth, 10);
        if (itemMonth && itemMonth !== reqM) continue;
      }
      if (filterYear && filterYear !== "all") {
        var reqY = parseInt(filterYear, 10);
        if (itemYear && itemYear !== reqY) continue;
      }

      // Parse history absensi dari kolom 9 (index 8)
      var historyAbsensi = null;
      try {
        var histRaw = (row[8] || "").toString().trim();
        if (histRaw && histRaw.charAt(0) === '{') {
          historyAbsensi = JSON.parse(histRaw);
        }
      } catch(parseErr) {
        historyAbsensi = null;
      }

      list.push({
        rowIndex: i + 2,
        tanggal: timeStr,
        nama: nama,
        kelasAsal: kelasAsal,
        dikickOleh: kicker,
        status: status,
        keterangan: keterangan || "-",
        kategori: kategori || (isBlacklist ? "BLACKLIST / Ditolak" : (isTerima ? "Dapat Diterima Kembali" : "-")),
        isPermanen: isPermanen,
        isBlacklist: isBlacklist,
        isTerima: isTerima,
        isTersedia: isTersedia,
        isAktif: isAktif,
        catatanAdmin: catatanAdmin || "-",
        bulan: itemMonth,
        tahun: itemYear,
        historyAbsensi: historyAbsensi
      });
    }

    return {
      success: true,
      data: list,
      stats: stats
    };
  } catch (err) {
    return { success: false, message: "Gagal mengambil data siswa keluar: " + err.toString() };
  }
}

/**
 * Menambahkan siswa yang di-kick ke kelas Sensei yang dipilih oleh Administrator
 */
function _assignKickedStudentToClass(studentName, targetSensei, currentUser, month, year) {
  try {
    currentUser = authUser(currentUser);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, message: "Akses Ditolak: Hanya Administrator yang berhak menempatkan siswa keluar!" };
    }

    if (!targetSensei) {
      return { success: false, message: "Silakan pilih kelas sensei tujuan!" };
    }

    var ss = getSS();
    if (!ss) return { success: false, message: "Spreadsheet tidak ditemukan." };

    // Cek apakah siswa berstatus Blacklist
    var kickedSheet = getKickedSheet(ss);
    var lastRow = kickedSheet.getLastRow();
    var targetName = cleanStudentName(studentName).toLowerCase().trim();

    if (lastRow >= 2) {
      var raw = kickedSheet.getRange(2, 1, lastRow - 1, Math.max(8, kickedSheet.getLastColumn())).getValues();
      for (var i = raw.length - 1; i >= 0; i--) {
        var rName = cleanStudentName(raw[i][1]).toLowerCase().trim();
        if (rName === targetName) {
          var rStatus = (raw[i][4] || "").toString().toLowerCase();
          var rKategori = (raw[i][6] || "").toString().toLowerCase();
          var rKet = (raw[i][5] || "").toString().trim();
          if (rStatus.indexOf("permanen") !== -1 && (rKategori.indexOf("blacklist") !== -1 || rKategori.indexOf("tolak") !== -1 || rKategori.indexOf("tidak") !== -1)) {
            return {
              success: false,
              message: "PENDAFTARAN DITOLAK: Siswa " + studentName + " berstatus KELUAR PERMANEN (BLACKLIST - TIDAK DAPAT DITERIMA LAGI). Alasan keluar: " + rKet
            };
          }
        }
      }
    }

    // Panggil addStudent untuk memasukkan siswa ke kelas target
    var addRes = _addStudent(targetSensei, studentName, currentUser, month, year);
    if (!addRes.success) {
      return addRes;
    }

    // Update status di Siswa_Keluar & pulihkan history absensi jika ada
    var restoredAttendanceCount = 0;
    try {
      if (lastRow >= 2) {
        var numKCols = Math.max(9, kickedSheet.getLastColumn());
        var rawK = kickedSheet.getRange(2, 1, lastRow - 1, numKCols).getValues();
        for (var k = 0; k < rawK.length; k++) {
          if (cleanStudentName(rawK[k][1]).toLowerCase().trim() === targetName) {
            kickedSheet.getRange(k + 2, 5).setValue("Aktif di " + targetSensei);
            var adminName = currentUser.name || currentUser.username || "Admin";
            var timeStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+7", "yyyy-MM-dd HH:mm");
            kickedSheet.getRange(k + 2, 8).setValue("Ditempatkan ke " + targetSensei + " oleh " + adminName + " pd " + timeStr);

            // Pulihkan riwayat absensi ke baris baru siswa di targetSensei jika data riwayat tersedia
            var histRaw = (rawK[k][8] || "").toString().trim();
            if (histRaw && histRaw.charAt(0) === '{' && addRes.insertRow) {
              try {
                var histObj = JSON.parse(histRaw);
                if (histObj && histObj.attendance) {
                  var nowObj = new Date();
                  var reqM = parseInt(month, 10) || (nowObj.getMonth() + 1);
                  var reqY = parseInt(year, 10) || nowObj.getFullYear();
                  var tSheet = getSheetForSensei(ss, targetSensei, reqM, reqY);
                  if (!tSheet) tSheet = ss.getSheetByName(targetSensei);
                  if (tSheet) {
                    var tLayout = getSheetColumnLayout(tSheet, reqM, reqY);
                    var daysInMonth = new Date(reqY, reqM, 0).getDate();
                    for (var d = 1; d <= daysInMonth; d++) {
                      var dVal = histObj.attendance[d];
                      var dNote = (histObj.notes && histObj.notes[d]) ? histObj.notes[d] : "";
                      var targetCol = (tLayout.dateStartCol - 1) + (d - 1) + 1; // 1-based column
                      if (dVal) {
                        tSheet.getRange(addRes.insertRow, targetCol).setValue(dVal);
                        restoredAttendanceCount++;
                      }
                      if (dNote) {
                        tSheet.getRange(addRes.insertRow, targetCol).setNote(dNote);
                      }
                    }
                  }
                }
              } catch(parseErr) {}
            }
          }
        }
      }
    } catch(e) {}

    var extraMsg = restoredAttendanceCount > 0 ? " (Riwayat " + restoredAttendanceCount + " hari absensi berhasil dipulihkan)" : "";
    return {
      success: true,
      message: "Siswa " + studentName + " berhasil dimasukkan ke kelas " + targetSensei + "!" + extraMsg
    };
  } catch (err) {
    return { success: false, message: "Gagal menambahkan siswa ke kelas: " + err.toString() };
  }
}

/**
 * Menandai siswa keluar permanen beserta kategorinya (KHUSUS ADMINISTRATOR)
 * Kategori: "Dapat Diterima Kembali" atau "BLACKLIST / Ditolak"
 */
function _setStudentPermanentStatus(studentName, category, adminNotes, currentUser) {
  try {
    currentUser = authUser(currentUser);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, message: "Akses Ditolak: Hanya Administrator yang berhak mengatur status permanen!" };
    }

    var ss = getSS();
    if (!ss) return { success: false, message: "Spreadsheet tidak ditemukan." };

    var kickedSheet = getKickedSheet(ss);
    var lastRow = kickedSheet.getLastRow();
    if (lastRow < 2) {
      return { success: false, message: "Data riwayat siswa keluar masih kosong." };
    }

    var targetName = cleanStudentName(studentName).toLowerCase().trim();
    var raw = kickedSheet.getRange(2, 1, lastRow - 1, Math.max(8, kickedSheet.getLastColumn())).getValues();
    var updated = false;

    for (var i = raw.length - 1; i >= 0; i--) {
      var rName = cleanStudentName(raw[i][1]).toLowerCase().trim();
      if (rName === targetName) {
        var rIdx = i + 2;
        kickedSheet.getRange(rIdx, 5).setValue("Keluar Permanen");
        kickedSheet.getRange(rIdx, 7).setValue(category);
        var adminName = currentUser.name || currentUser.username || "Admin";
        var timeStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+7", "yyyy-MM-dd HH:mm");
        var note = (adminNotes ? (adminNotes + " - ") : "") + category + " (oleh " + adminName + " pd " + timeStr + ")";
        kickedSheet.getRange(rIdx, 8).setValue(note);
        updated = true;
      }
    }

    if (!updated) {
      return { success: false, message: "Siswa " + studentName + " tidak ditemukan di riwayat Siswa Keluar." };
    }

    return {
      success: true,
      message: "Status siswa " + studentName + " berhasil diatur menjadi Keluar Permanen: " + category + "!"
    };
  } catch (err) {
    return { success: false, message: "Gagal menyimpan status permanen: " + err.toString() };
  }
}

/**
 * Membuka kembali status siswa menjadi Tersedia (Bebas) (KHUSUS ADMINISTRATOR)
 */
function _reopenStudentStatus(studentName, currentUser) {
  try {
    currentUser = authUser(currentUser);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, message: "Akses Ditolak: Hanya Administrator yang berhak mengubah status siswa!" };
    }

    var ss = getSS();
    if (!ss) return { success: false, message: "Spreadsheet tidak ditemukan." };

    var kickedSheet = getKickedSheet(ss);
    var lastRow = kickedSheet.getLastRow();
    if (lastRow < 2) return { success: false, message: "Data kosong." };

    var targetName = cleanStudentName(studentName).toLowerCase().trim();
    var raw = kickedSheet.getRange(2, 1, lastRow - 1, Math.max(8, kickedSheet.getLastColumn())).getValues();
    var updated = false;

    for (var i = raw.length - 1; i >= 0; i--) {
      var rName = cleanStudentName(raw[i][1]).toLowerCase().trim();
      if (rName === targetName) {
        var rIdx = i + 2;
        kickedSheet.getRange(rIdx, 5).setValue("Tersedia (Bebas)");
        kickedSheet.getRange(rIdx, 7).setValue("-");
        var adminName = currentUser.name || currentUser.username || "Admin";
        var timeStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+7", "yyyy-MM-dd HH:mm");
        kickedSheet.getRange(rIdx, 8).setValue("Status dibuka kembali menjadi Tersedia oleh " + adminName + " pd " + timeStr);
        updated = true;
      }
    }

    if (!updated) return { success: false, message: "Siswa " + studentName + " tidak ditemukan." };

    return {
      success: true,
      message: "Status siswa " + studentName + " berhasil dikembalikan menjadi Tersedia (Bebas)!"
    };
  } catch (err) {
    return { success: false, message: "Gagal mengubah status: " + err.toString() };
  }
}

/**
 * Format Otomatis & Pembuatan Users Sheet
 */
function setupSpreadsheetFormat() {
  try {
    var ss = getSS();
    createUsersSheet(ss);
    getKickedSheet(ss);

    var senseiNames = [
      "Singgih Sensei", 
      "Esti Sensei", 
      "Khaerul Sensei", 
      "Robbi Sensei", 
      "Rowi Sensei",
      "Singgih sensei Kelas karyawan",
      "rowi sensei Kelas karyawan"
    ];
    senseiNames.forEach(function(sName) {
      var sheet = ss.getSheetByName(sName);
      if (!sheet) sheet = ss.insertSheet(sName);
      applyConditionalFormatting(sheet);
    });
    
    return { success: true, message: "Sheet Users, Siswa_Keluar & Format Warna berhasil diperbarui!" };
  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

function applyConditionalFormatting(sheet) {
  var range = sheet.getRange("D5:AH50");
  
  var ruleH = SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("H").setBackground("#DCFCE7").setFontColor("#15803D").setBold(true).setRanges([range]).build();
  var ruleS = SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("S").setBackground("#E0F2FE").setFontColor("#0369A1").setBold(true).setRanges([range]).build();
  var ruleI = SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("I").setBackground("#FEF3C7").setFontColor("#B45309").setBold(true).setRanges([range]).build();
  var ruleA = SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("A").setBackground("#FEE2E2").setFontColor("#B91C1C").setBold(true).setRanges([range]).build();
  var ruleL = SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("L").setBackground("#334155").setFontColor("#FFFFFF").setBold(true).setRanges([range]).build();

  var rules = sheet.getConditionalFormatRules();
  rules.push(ruleH, ruleS, ruleI, ruleA, ruleL);
  sheet.setConditionalFormatRules(rules);
}

function saveDailyAttendance() { var a = arguments; return withLock(function() { return _saveDailyAttendance.apply(null, a); }); }

function addStudent() { var a = arguments; return withLock(function() { return _addStudent.apply(null, a); }); }

function kickStudent() { var a = arguments; return withLock(function() { return _kickStudent.apply(null, a); }); }

function transferStudent() { var a = arguments; return withLock(function() { return _transferStudent.apply(null, a); }); }

function assignKickedStudentToClass() { var a = arguments; return withLock(function() { return _assignKickedStudentToClass.apply(null, a); }); }

function setStudentPermanentStatus() { var a = arguments; return withLock(function() { return _setStudentPermanentStatus.apply(null, a); }); }

function reopenStudentStatus() { var a = arguments; return withLock(function() { return _reopenStudentStatus.apply(null, a); }); }