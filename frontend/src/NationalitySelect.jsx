import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { findNationality, searchNationalities } from "./nationalities";

export default function NationalitySelect({ value, onChange, disabled = false }) {
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const root = useRef(null), input = useRef(null), optionsId = useId();
  const options = searchNationalities(showAll ? "" : value);
  const choose = (country) => { onChange(country.name); setOpen(false); input.current?.focus(); };
  useEffect(() => {
    const close = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  useEffect(() => { setActive(0); }, [value]);
  useEffect(() => { if (open) document.getElementById(`${optionsId}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);
  useEffect(() => { input.current?.setCustomValidity(value && !findNationality(value) ? "Select a nationality from the list." : ""); }, [value]);
  return <div className="country-select" ref={root}>
    <div className="country-select-input"><input ref={input} required disabled={disabled} value={value} onChange={(event) => { onChange(event.target.value); setShowAll(false); setOpen(true); }}
      role="combobox" aria-label="Nationality" aria-expanded={open} aria-controls={optionsId} aria-autocomplete="list" aria-activedescendant={open && options[active] ? `${optionsId}-${active}` : undefined}
      placeholder="Search or select a nationality" autoComplete="off" onFocus={() => { setShowAll(true); setOpen(true); }} onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") { setOpen(false); return; }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); setActive((current) => Math.max(0, Math.min(options.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))); }
        if (event.key === "Enter" && open) { event.preventDefault(); if (options[active]) choose(options[active]); }
      }} /><button type="button" disabled={disabled} aria-label="Show nationalities" aria-expanded={open} onClick={() => { if (open) { setOpen(false); } else { input.current?.focus(); setShowAll(true); setOpen(true); } }}><ChevronDown size={17} /></button></div>
    {open && !disabled && <ul id={optionsId} className="country-select-options" role="listbox" aria-label="Nationalities">{options.length ? options.map((country, index) => <li key={country.name} id={`${optionsId}-${index}`} role="option" aria-selected={country.name === value} className={index === active ? "highlighted" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(country)}><span>{country.name}</span>{country.name === value && <Check size={15} />}</li>) : <li className="country-select-empty" role="presentation">No nationalities found. Try another spelling.</li>}</ul>}
  </div>;
}
