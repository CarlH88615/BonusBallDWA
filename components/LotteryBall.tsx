
import React from 'react';

interface BallProps {
  number: number;
  className?: string;
  delay?: string;
  opacity?: number;
  blur?: string;
  hideShadow?: boolean;
  showNumber?: boolean;
}

const getBallStyles = (num: number) => {
  // UK National Lottery Style Color Schemes
  if (num >= 1 && num <= 9) return { bg: '#ffffff', text: '#000000', shadow: 'rgba(0,0,0,0.2)' }; 
  if (num >= 10 && num <= 19) return { bg: '#005eb8', text: '#ffffff', shadow: 'rgba(0,30,80,0.4)' }; 
  if (num >= 20 && num <= 29) return { bg: '#e4007f', text: '#ffffff', shadow: 'rgba(100,0,50,0.4)' }; 
  if (num >= 30 && num <= 39) return { bg: '#009639', text: '#ffffff', shadow: 'rgba(0,50,20,0.4)' }; 
  if (num >= 40 && num <= 49) return { bg: '#ffd100', text: '#000000', shadow: 'rgba(80,60,0,0.3)' }; 
  return { bg: '#60269e', text: '#ffffff', shadow: 'rgba(40,0,80,0.4)' }; 
};

export const LotteryBall: React.FC<BallProps> = ({ 
  number, 
  className = "", 
  delay = "0s", 
  opacity = 1, 
  blur = "0",
  hideShadow = false,
  showNumber = true
}) => {
  const styles = getBallStyles(number);
  const displayNum = number < 10 ? `0${number}` : number.toString();

  return (
    <div 
      className={`relative aspect-square ${className} transition-all duration-700 select-none`} 
      style={{ 
        animationDelay: delay,
        opacity: opacity,
        filter: blur !== "0" ? `blur(${blur}) saturate(0.8)` : 'none'
      }}
    >
      {/* Dynamic Floor Shadow */}
      {!hideShadow && (
        <div className="absolute -bottom-[5%] left-1/2 -translate-x-1/2 w-[85%] h-[15%] bg-black/40 blur-md rounded-[100%] pointer-events-none"></div>
      )}
      
      {/* The Sphere */}
      <div 
        className="relative w-full h-full rounded-full flex items-center justify-center overflow-hidden shadow-2xl"
        style={{ 
          backgroundColor: styles.bg,
          backgroundImage: `
            radial-gradient(circle at 35% 35%, rgba(255,255,255,0.6) 0%, transparent 50%),
            radial-gradient(circle at 50% 50%, transparent 60%, rgba(0,0,0,0.4) 100%)
          `,
          boxShadow: `inset -6px -6px 15px rgba(0,0,0,0.4), inset 6px 6px 15px rgba(255,255,255,0.2)`
        }}
      >
        {/* Specular Shine Overlay */}
        <div className="absolute top-[10%] left-[15%] w-[40%] h-[30%] bg-gradient-to-br from-white/40 to-transparent rounded-full blur-[2px] rotate-[-15deg]"></div>

        {/* The Number Plate (Standardized) */}
        <div className={`relative z-10 flex items-center justify-center w-[75%] h-[75%] rounded-full bg-white/5 border border-black/5 shadow-inner transition-opacity duration-1000 ${showNumber ? 'opacity-100' : 'opacity-0'}`}>
          <span 
            className="font-black text-[3.5vw] md:text-[1.8rem] lg:text-[2rem] leading-none tracking-tighter" 
            style={{ 
              color: styles.text,
              textShadow: styles.text === '#ffffff' ? '0 1px 2px rgba(0,0,0,0.2)' : 'none'
            }}
          >
            {displayNum}
          </span>
        </div>
      </div>
    </div>
  );
};
