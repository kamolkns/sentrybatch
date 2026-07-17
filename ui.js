export function setText(element, value){ if(element) element.textContent = String(value ?? ''); }
export function setVisible(element, visible){ if(element) element.hidden = !visible; }
