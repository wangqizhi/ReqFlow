import {env} from 'cloudflare:workers';
export function storage(){if(!env.DB)throw new Error('数据服务暂不可用');return env.DB;}
