import { ethers } from 'ethers';
import { provider, BOT_ADDRESS } from './config.js';

const ERC20_BAL = ['function balanceOf(address) view returns (uint256)'];
const ERC20_DEC = ['function decimals() view returns (uint8)'];

export async function getEth() {
  const wei = await provider.getBalance(BOT_ADDRESS);
  return Number(ethers.formatEther(wei));
}

export async function getUsdc(usdcAddress) {
  const c = new ethers.Contract(usdcAddress, [...ERC20_BAL, ...ERC20_DEC], provider);
  const [bal, dec] = await Promise.all([c.balanceOf(BOT_ADDRESS), c.decimals()]);
  return Number(bal) / 10 ** Number(dec);
}

export async function blockNumber() { return provider.getBlockNumber(); }
