# Otokrati

Potezna igra osvajanja otočja za preglednik, za djecu od 10 do 13 godina. Igraš protiv raka Brune, galebice Gite ili
hobotnice Oktavije, ili protiv prijatelja na istom uređaju. Osvajaš polja, skupljaš bisere za trikove i u svakoj partiji
biraš moći koje gradiš do kraja.

**Kako igrati:** preuzmi [index.html](index.html) i otvori ga u pregledniku. Ništa se ne instalira i ništa ne ide na
mrežu; napredak se sprema u pregledniku.

Cijela igra je ta jedna datoteka: grafika se crta kodom, a zvuk se sintetizira. Testovi i alati su uz nju:

```sh
node --test                          # pravila, AI, napredovanje
node tools/simulate.js --games 300   # turnir računala protiv računala
```
