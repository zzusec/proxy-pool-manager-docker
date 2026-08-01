/**
 * Autonomous systems that only ever sell hosting: if the local GeoLite ASN
 * database puts an address in one of these, no paid lookup can change the
 * answer, so the classifier settles it offline and saves the quota for the
 * addresses that are actually ambiguous.
 *
 * Deliberately conservative — only operators whose entire business is compute
 * or CDN. Anything that also sells consumer broadband (Comcast, Telefónica,
 * China Telecom, Cogent…) stays out, because those ranges genuinely need
 * ipdata's asn.type / company.type split to tell a datacenter block from a
 * residential one.
 */
export const DATACENTER_ASNS = new Map([
  [16509, 'Amazon AWS'], [14618, 'Amazon AWS'], [39111, 'Amazon'], [7224, 'Amazon'],
  [8075, 'Microsoft Azure'], [8068, 'Microsoft'], [8069, 'Microsoft'],
  [15169, 'Google'], [396982, 'Google Cloud'], [19527, 'Google'],
  [31898, 'Oracle Cloud'], [14061, 'DigitalOcean'], [20473, 'Vultr / Choopa'],
  [63949, 'Akamai / Linode'], [48282, 'Linode'], [16276, 'OVH'], [35540, 'OVH'],
  [24940, 'Hetzner'], [212317, 'Hetzner'], [51167, 'Contabo'], [40021, 'Contabo'],
  [60781, 'Leaseweb'], [16265, 'Leaseweb'], [30633, 'Leaseweb'],
  [12876, 'Scaleway / Online SAS'], [39729, 'Scaleway'],
  [45102, 'Alibaba Cloud'], [37963, 'Alibaba Cloud'], [45090, 'Tencent Cloud'], [132203, 'Tencent Cloud'],
  [9009, 'M247'], [56971, 'M247'], [40676, 'Psychz Networks'], [8100, 'QuadraNet'],
  [53667, 'FranTech / BuyVM'], [54290, 'Hostwinds'], [36352, 'ColoCrossing'],
  [35913, 'DediPath'], [62904, 'Eonix'], [46844, 'Sharktech'], [32475, 'SingleHop'],
  [13335, 'Cloudflare'], [209242, 'Cloudflare'], [20940, 'Akamai'], [16625, 'Akamai'],
  [54113, 'Fastly'], [22822, 'Limelight'], [13238, 'Yandex Cloud'], [200350, 'Yandex Cloud'],
  [14127, 'Cyxtera'], [29802, 'Hivelocity'], [55081, 'Hivelocity'], [26496, 'GoDaddy / Newfold'],
  [46606, 'Unified Layer / Bluehost'], [32244, 'Liquid Web'], [19871, 'Network Solutions'],
  [21769, 'Rackspace'], [12200, 'Rackspace'], [27357, 'Rackspace'],
  [199524, 'G-Core Labs'], [202422, 'G-Core Labs'], [64425, 'Serverion'],
  [206092, 'InterLIR'], [51852, 'Private Layer'], [43350, 'NForce'],
  [49505, 'Selectel'], [29182, 'JSC IOT / Serverel'], [50673, 'Serverius'],
  [24961, 'WIIT / myLoc'], [8560, 'IONOS'], [197540, 'netcup'], [51862, 'Fastnet / Aruba'],
  [31034, 'Aruba'], [198047, 'Aruba'], [62240, 'Clouvider'], [214940, 'IPXO'],
  [211252, 'Delis'],
  // Added 2026-07-31 to cut the paid-lookup bill: same rule as above — pure
  // compute/CDN operators only, no ASN that also sells consumer broadband.
  [132335, 'Alibaba Cloud'], [134963, 'Alibaba Cloud'], [136258, 'Alibaba Cloud'],
  [55990, 'Huawei Cloud'], [136907, 'Huawei Cloud'], [38365, 'Baidu Cloud'],
  [45062, 'NetEase Cloud'], [63888, 'Joyent / Triton'], [394699, 'Fly.io'],
  [54825, 'Equinix Metal / Packet'], [30081, 'CacheNetworks'],
  [60068, 'Datacamp / CDN77'], [212238, 'Datacamp / CDN77'],
  [23470, 'ReliableSite'], [53850, 'ReliableSite'], [21859, 'Zenlayer'],
  [3223, 'Voxility'], [39572, 'AdvancedHosting'], [206264, 'Amarutu / Choopa'],
  [47583, 'Hostinger'], [61317, 'Hostinger'], [396356, 'Latitude.sh'],
  [26347, 'DreamHost'], [22612, 'Namecheap Hosting'], [20860, 'Iomart'],
  [42831, 'UK Dedicated Servers'], [29066, 'velia.net'], [35916, 'MULTACOM'],
  [40065, 'CNSERVERS'], [63023, 'GlobalTeleHost'], [64236, 'Unreal Servers'],
  [9370, 'Sakura Internet'], [398101, 'GoDaddy'],
]);

/**
 * Resolve an ASN (number, "AS16509" or a bare string) to a hosting operator
 * name, or an empty string when the network is not a known datacenter.
 */
export function datacenterAsnName(asn) {
  const number = Number.parseInt(String(asn ?? '').replace(/^as/i, ''), 10);
  if (!Number.isInteger(number)) return '';
  return DATACENTER_ASNS.get(number) || '';
}
