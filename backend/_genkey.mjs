const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let s = "G";
for (let i = 0; i < 55; i++) s += c[Math.floor(Math.random() * c.length)];
console.log(s);
