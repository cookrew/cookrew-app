// FRIENDLY NAMES for a PC's firmware strings (machine-profile.ts): what a
// desktop figure's caption says when the hardware is not a Mac.
//
// Firmware strings are raw: 'Micro-Star International Co., Ltd.', a Lenovo's
// machine-type code in product_name with the real name in product_version,
// a self-built PC whose product is 'To Be Filled By O.E.M.' and whose only
// honest name is its motherboard's. Pure; every input is already read.

/** Strings boards ship when nobody filled the field in. */
const PLACEHOLDER =
  /^(?:to be filled by o\.?e\.?m\.?|system manufacturer|system product name|system version|default string|not specified|not applicable|none|unknown|o\.?e\.?m\.?|type1productconfigid|invalid|x\.x|standard|0+|1\.0)$/i

/** Trimmed, or null when empty or a placeholder. */
export function cleanFact(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 || PLACEHOLDER.test(trimmed) ? null : trimmed
}

const VENDORS: ReadonlyArray<[pattern: RegExp, name: string]> = [
  [/^micro-?star/i, 'MSI'],
  [/^asustek|^asus\b/i, 'ASUS'],
  [/^gigabyte/i, 'Gigabyte'],
  [/^asrock/i, 'ASRock'],
  [/^dell\b/i, 'Dell'],
  [/^hewlett[- ]packard enterprise|^hpe\b/i, 'HPE'],
  [/^hewlett[- ]packard|^hp\b/i, 'HP'],
  [/^lenovo\b/i, 'Lenovo'],
  [/^microsoft corporation/i, 'Microsoft'],
  [/^intel\b/i, 'Intel'],
  [/^framework\b/i, 'Framework'],
  [/^system76/i, 'System76'],
  [/^super ?micro/i, 'Supermicro'],
  [/^acer\b/i, 'Acer'],
  [/^samsung/i, 'Samsung'],
  [/^raspberry pi/i, 'Raspberry Pi'],
  [/^apple\b/i, 'Apple']
]

const CORPORATE_SUFFIX = /[,\s]+(?:inc\.?|incorporated|corporation|corp\.?|co\.?,?\s*ltd\.?|ltd\.?|gmbh|llc|limited|co\.)$/i

/** 'Micro-Star International Co., Ltd.' → 'MSI'; 'Foo Systems, Inc.' → 'Foo Systems'. */
export function vendorName(raw: string | null | undefined): string | null {
  const vendor = cleanFact(raw)
  if (vendor === null) return null
  const known = VENDORS.find(([pattern]) => pattern.test(vendor))
  if (known) return known[1]
  let out = vendor
  for (let pass = 0; pass < 2; pass += 1) out = out.replace(CORPORATE_SUFFIX, '')
  return out.length > 0 ? out : vendor
}

/** 'Dell' + 'OptiPlex 7010' → 'Dell OptiPlex 7010'; never 'Raspberry Pi Raspberry Pi 5…'. */
export function productLabel(vendor: string | null, product: string | null): string | null {
  if (product === null) return vendor
  if (vendor === null || product.toLowerCase().startsWith(vendor.toLowerCase())) return product
  return `${vendor} ${product}`
}

export interface PcStrings {
  vendor: string | null | undefined
  product: string | null | undefined
  /** DMI product_version / Win32_ComputerSystemProduct.Version: where Lenovo keeps the name. */
  version?: string | null
  boardVendor?: string | null
  boardName?: string | null
  /** /sys/firmware/devicetree/base/model: an ARM board names itself here, not in DMI. */
  deviceTree?: string | null
}

export interface PcIdentity {
  vendor: string | null
  /** What the figure's caption says. */
  label: string | null
  /** The vendor's own id for it. */
  model: string | null
}

/** The friendliest honest name the firmware strings support. */
export function pcIdentity(strings: PcStrings): PcIdentity {
  const deviceTree = cleanFact(strings.deviceTree?.replace(/\0/g, ''))
  if (deviceTree !== null && cleanFact(strings.product) === null) {
    const vendor = vendorName(deviceTree)
    return { vendor, label: deviceTree, model: deviceTree }
  }
  const vendor = vendorName(strings.vendor)
  const product = cleanFact(strings.product)
  const version = cleanFact(strings.version)
  // Lenovo puts a machine-type code in product and the name in version.
  if (vendor === 'Lenovo' && version !== null && /[a-z]/i.test(version) && /\s/.test(version)) {
    return { vendor, label: productLabel(vendor, version), model: product }
  }
  if (product !== null) return { vendor, label: productLabel(vendor, product), model: product }
  // A self-built PC: the motherboard is the only name it has.
  const boardVendor = vendorName(strings.boardVendor)
  const board = cleanFact(strings.boardName)
  if (board !== null) return { vendor: vendor ?? boardVendor, label: productLabel(boardVendor, board), model: board }
  return { vendor, label: vendor, model: null }
}
