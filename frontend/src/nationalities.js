import { countryOptions, findCountry } from "./countries.js";

// Nationality names: https://www.gov.uk/government/publications/nationalities/list-of-nationalities
// Country codes also recognise country names saved by the previous profile form.
const entries = `AF|Afghan
AL|Albanian
DZ|Algerian
US UM AS|American
AD|Andorran
AO|Angolan
AI|Anguillan
AG|Citizen of Antigua and Barbuda
AR|Argentine
AM|Armenian
AU CX CC HM NF|Australian
AT|Austrian
AZ|Azerbaijani
BS|Bahamian
BH|Bahraini
BD|Bangladeshi
BB|Barbadian
BY|Belarusian
BE|Belgian
BZ|Belizean
BJ|Beninese
BM|Bermudian
BT|Bhutanese
BO|Bolivian
BA|Citizen of Bosnia and Herzegovina
BW|Botswanan
BR|Brazilian
GB GG IM JE IO GS|British
VG|British Virgin Islander
BN|Bruneian
BG|Bulgarian
BF|Burkinan
MM|Burmese
BI|Burundian
KH|Cambodian
CM|Cameroonian
CA|Canadian
CV|Cape Verdean
KY|Cayman Islander
CF|Central African
TD|Chadian
CL|Chilean
CN|Chinese
CO|Colombian
KM|Comoran
CG|Congolese (Congo)
CD|Congolese (DRC)
CK|Cook Islander
CR|Costa Rican
HR|Croatian
CU|Cuban
CY|Cypriot
CZ|Czech
DK|Danish
DJ|Djiboutian
DM|Dominican
DO|Citizen of the Dominican Republic
NL AW BQ CW SX|Dutch
TL|East Timorese
EC|Ecuadorean
EG|Egyptian
AE|Emirati
GQ|Equatorial Guinean
ER|Eritrean
EE|Estonian
ET|Ethiopian
FO|Faroese
FJ|Fijian
PH|Filipino
FI AX|Finnish
FR GF GP RE YT PM BL MF NC PF TF|French
GA|Gabonese
GM|Gambian
GE|Georgian
DE|German
GH|Ghanaian
GI|Gibraltarian
GR|Greek
GL|Greenlandic
GD|Grenadian
GU|Guamanian
GT|Guatemalan
GW|Citizen of Guinea-Bissau
GN|Guinean
GY|Guyanese
HT|Haitian
HN|Honduran
HK|Hong Konger
HU|Hungarian
IS|Icelandic
IN|Indian
ID|Indonesian
IR|Iranian
IQ|Iraqi
IE|Irish
IL|Israeli
IT|Italian
CI|Ivorian
JM|Jamaican
JP|Japanese
JO|Jordanian
KZ|Kazakh
KE|Kenyan
KN|Kittitian
KI|Citizen of Kiribati
XK|Kosovan
KW|Kuwaiti
KG|Kyrgyz
LA|Lao
LV|Latvian
LB|Lebanese
LR|Liberian
LY|Libyan
LI|Liechtenstein citizen
LT|Lithuanian
LU|Luxembourger
MO|Macanese
MK|Macedonian
MG|Malagasy
MW|Malawian
MY|Malaysian
MV|Maldivian
ML|Malian
MT|Maltese
MH|Marshallese
MQ|Martiniquais
MR|Mauritanian
MU|Mauritian
MX|Mexican
FM|Micronesian
MD|Moldovan
MC|Monegasque
MN|Mongolian
ME|Montenegrin
MS|Montserratian
MA|Moroccan
LS|Mosotho
MZ|Mozambican
NA|Namibian
NR|Nauruan
NP|Nepalese
NZ TK|New Zealander
NI|Nicaraguan
NG|Nigerian
NE|Nigerien
NU|Niuean
KP|North Korean
NO BV SJ|Norwegian
OM|Omani
PK|Pakistani
PW|Palauan
PS|Palestinian
PA|Panamanian
PG|Papua New Guinean
PY|Paraguayan
PE|Peruvian
PN|Pitcairn Islander
PL|Polish
PT|Portuguese
PR|Puerto Rican
QA|Qatari
RO|Romanian
RU|Russian
RW|Rwandan
SV|Salvadorean
SM|Sammarinese
WS|Samoan
ST|Sao Tomean
SA|Saudi Arabian
SN|Senegalese
RS|Serbian
SC|Citizen of Seychelles
SL|Sierra Leonean
SG|Singaporean
SK|Slovak
SI|Slovenian
SB|Solomon Islander
SO|Somali
ZA|South African
KR|South Korean
SS|South Sudanese
ES|Spanish
LK|Sri Lankan
SH|St Helenian
LC|St Lucian
|Stateless
SD|Sudanese
SR|Surinamese
SZ|Swazi
SE|Swedish
CH|Swiss
SY|Syrian
TW|Taiwanese
TJ|Tajik
TZ|Tanzanian
TH|Thai
TG|Togolese
TO|Tongan
TT|Trinidadian
|Tristanian
TN|Tunisian
TR|Turkish
TM|Turkmen
TC|Turks and Caicos Islander
TV|Tuvaluan
UG|Ugandan
UA|Ukrainian
UY|Uruguayan
UZ|Uzbek
VA|Vatican citizen
VU|Citizen of Vanuatu
VE|Venezuelan
VN|Vietnamese
VC|Vincentian
WF|Wallisian
YE|Yemeni
ZM|Zambian
ZW|Zimbabwean`;

const normalise = (value) => String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const byCode = new Map();
const byName = new Map();
for (const row of entries.split("\n")) {
  const [codes, name] = row.split("|");
  const key = normalise(name);
  if (!byName.has(key)) byName.set(key, { name });
  for (const code of codes.split(" ").filter(Boolean)) byCode.set(code, byName.get(key));
}
export const nationalityOptions = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
const aliases = { english: "British", scottish: "British", welsh: "British", "northern irish": "British", cymraes: "British", cymro: "British", prydeinig: "British" };

export function findNationality(value) {
  const text = normalise(value);
  const nationality = byName.get(text) || byName.get(normalise(aliases[text]));
  if (nationality) return nationality;
  const country = findCountry(value);
  return country && byCode.get(country.code);
}

export function searchNationalities(value) {
  const text = normalise(value);
  const countryMatches = new Set(countryOptions.filter((country) => normalise(country.name).includes(text) || country.code.toLowerCase() === text).map((country) => byCode.get(country.code)));
  const exact = findNationality(value);
  return nationalityOptions.filter((option) => !text || normalise(option.name).includes(text) || countryMatches.has(option) || option === exact)
    .sort((a, b) => Number(b === exact) - Number(a === exact) || Number(normalise(b.name).startsWith(text)) - Number(normalise(a.name).startsWith(text)) || a.name.localeCompare(b.name));
}
