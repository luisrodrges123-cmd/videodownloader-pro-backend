const HOSTS={tiktok:["tiktok.com"],instagram:["instagram.com","instagr.am"],facebook:["facebook.com","fb.com","fb.watch"]};
export function validateVideoUrl(input){
 if(typeof input!=="string"||input.length>2048)return {valid:false,reason:"URL inválida."};
 let u;try{u=new URL(input)}catch{return {valid:false,reason:"URL inválida."}}
 if(u.protocol!=="https:"||u.username||u.password||(u.port&&u.port!=="443"))return {valid:false,reason:"Usa un enlace HTTPS válido."};
 const host=u.hostname.toLowerCase().replace(/^www\./,"");
 for(const [platform,domains] of Object.entries(HOSTS)){
  if(domains.some(d=>host===d||host.endsWith("."+d)))return {valid:true,platform,normalizedUrl:u.toString()};
 }
 return {valid:false,reason:"Solo se aceptan enlaces de TikTok, Instagram o Facebook."};
}
